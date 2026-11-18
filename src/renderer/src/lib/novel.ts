import type { PDFDocumentProxy } from 'pdfjs-dist'
import { OPS } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { PDFDocument, PDFFont, StandardFonts, rgb, setWordSpacing, type PDFPage } from 'pdf-lib'

/**
 * Novels (light novels and the like) are PDFs with a text layer: their words are read from it instead
 * of being found on a picture, translated paragraph by paragraph, and set again on pages of the same
 * size. Pages that are pictures (cover, illustrations) are kept as they are.
 */

/** One piece of a novel's flow, in reading order. */
export type NovelPiece =
  /** A paragraph or a chapter title; `joins` continues the paragraph before (it ran onto the next page). */
  | { kind: 'text'; heading: boolean; text: string; page: number; joins: boolean; indent: boolean }
  /** A scene break (an ornament, or a line of only symbols). */
  | { kind: 'break'; page: number }
  /** A page kept as it is: a picture, or one with no text at all. */
  | { kind: 'picture'; page: number }

/** A paragraph to translate: one or more pieces (a paragraph split by a page break is sent whole). */
export interface NovelParagraph {
  id: number
  text: string
  heading: boolean
  /** Starts a new page in the output (a chapter title that opened a page in the original). */
  newPage: boolean
  indent: boolean
  pages: number[]
}

export type NovelFlow = ({ kind: 'paragraph'; paragraph: NovelParagraph } | { kind: 'break' } | { kind: 'picture'; page: number })[]

/** Characters a page needs in its text layer to count as text (a picture's caption or a page number does not). */
const TEXT_PAGE = 200
/** Share of the page an image covers above which it is a picture page; below, an ornament. */
const PICTURE_AREA = 0.2

/** A PDF whose sampled pages mostly have a text layer: a novel, not a comic. */
export async function looksLikeNovel(doc: PDFDocumentProxy): Promise<boolean> {
  const total = doc.numPages
  const sample = [...new Set(Array.from({ length: Math.min(12, total) }, (_v, i) => 1 + Math.floor(((i + 0.5) * total) / Math.min(12, total))))]
  let text = 0
  for (const number of sample) {
    const page = await doc.getPage(number)
    const content = await page.getTextContent()
    if (content.items.reduce((n, it) => n + ('str' in it ? it.str.length : 0), 0) >= TEXT_PAGE) text++
  }
  return text >= sample.length / 2
}

interface Line {
  text: string
  x: number
  y: number
  end: number
  size: number
}

/** The pieces of one page, in reading order. */
export async function readNovelPage(doc: PDFDocumentProxy, number: number): Promise<NovelPiece[]> {
  const page = await doc.getPage(number)
  const { width, height } = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const items = content.items.filter((it): it is TextItem => 'str' in it)
  const chars = items.reduce((n, it) => n + it.str.length, 0)
  const images = await imagesOn(doc, number)
  const pictureArea = images.reduce((sum, img) => sum + img.area, 0) / (width * height)
  if (chars < TEXT_PAGE && (pictureArea >= PICTURE_AREA || chars === 0)) return [{ kind: 'picture', page: number }]

  // Words on one baseline make a line; the PDF lists them in reading order.
  const lines: Line[] = []
  for (const item of items) {
    const [, , , , x, y] = item.transform
    const size = Math.abs(item.transform[3]) || item.height
    const last = lines.at(-1)
    if (last && Math.abs(last.y - y) < size * 0.5) {
      const gap = x - last.end
      if (item.str && gap > size * 0.15 && !last.text.endsWith(' ') && !item.str.startsWith(' ')) last.text += ' '
      last.text += item.str
      last.end = Math.max(last.end, x + item.width)
      last.size = Math.max(last.size, size)
    } else if (item.str.trim()) {
      lines.push({ text: item.str, x, y, end: x + item.width, size })
    }
  }
  const kept = lines.filter((l) => l.text.trim() && !/^\s*\d{1,4}\s*$/.test(l.text))
  if (!kept.length) return [{ kind: 'picture', page: number }]

  const body = mode(kept.map((l) => Math.round(l.size)))
  const left = mode(kept.filter((l) => Math.round(l.size) === body).map((l) => Math.round(l.x)))
  const right = Math.max(...kept.map((l) => l.end))
  const leading = mode(kept.slice(1).map((l, i) => Math.round(kept[i].y - l.y)).filter((d) => d > 0)) || body * 1.4
  // Small images between the lines are scene-break ornaments: kept as breaks where they sit.
  const ornaments = images.filter((img) => img.area / (width * height) < PICTURE_AREA).map((img) => img.y)

  // Books that indent their paragraphs mark them so; a line ending early then only ends one when it is
  // well short (text set ragged, not justified, has lines a word short everywhere).
  const indentsParagraphs = kept.filter((l) => l.x > left + body * 0.8 && l.x - left < (right - left) * 0.3).length >= 2
  const shortLine = indentsParagraphs ? (right - left) * 0.4 : body * 2.5
  const pieces: NovelPiece[] = []
  let current: Extract<NovelPiece, { kind: 'text' }> | null = null
  let previous: Line | null = null
  for (const line of kept) {
    for (const y of ornaments.filter((o) => (previous ? o < previous.y : true) && o > line.y)) {
      pieces.push({ kind: 'break', page: number })
      current = null
      ornaments.splice(ornaments.indexOf(y), 1)
    }
    const text = line.text.replace(/\s+/g, ' ').trim()
    const heading = line.size > body * 1.2
    const symbols = !/\p{L}|\p{N}/u.test(text)
    const indented = line.x > left + body * 0.8 && line.x - left < (right - left) * 0.3
    const centered = Math.abs((line.x + line.end) / 2 - (left + right) / 2) < body && line.end < right - body * 3
    const gap = previous ? previous.y - line.y : 0
    if (symbols && (centered || text.length <= 5)) {
      pieces.push({ kind: 'break', page: number })
      current = null
    } else if (heading) {
      if (current?.heading && previous && gap < line.size * 2) current.text += ` ${text}`
      else pieces.push((current = { kind: 'text', heading: true, text, page: number, joins: false, indent: false }))
    } else {
      const ended = previous ? previous.end < right - shortLine : true
      const fresh = !current || current.heading || indented || ended || gap > leading * 1.6
      if (fresh) {
        pieces.push((current = { kind: 'text', heading: false, text, page: number, joins: false, indent: indented }))
      } else {
        current!.text = joinLine(current!.text, text)
      }
    }
    previous = line
  }
  for (const _y of ornaments) pieces.push({ kind: 'break', page: number })

  // The first paragraph goes on from the last page's when it is not indented and that one did not end a sentence.
  const first = pieces[0]
  if (first?.kind === 'text' && !first.heading && !first.indent) first.joins = true
  return pieces
}

/** Every page's pieces joined into the paragraphs to translate, and the order to set them in. */
export function buildFlow(pages: NovelPiece[][]): NovelFlow {
  const flow: NovelFlow = []
  let last: NovelParagraph | null = null
  let id = 0
  for (const pieces of pages) {
    pieces.forEach((piece, index) => {
      if (piece.kind === 'picture') {
        flow.push({ kind: 'picture', page: piece.page })
        last = null
      } else if (piece.kind === 'break') {
        flow.push({ kind: 'break' })
        last = null
      } else if (piece.joins && last && !last.heading && !/[.!?…"”’»)\]]$/.test(last.text)) {
        last.text = joinLine(last.text, piece.text)
        if (!last.pages.includes(piece.page)) last.pages.push(piece.page)
      } else {
        last = { id: id++, text: piece.text, heading: piece.heading, newPage: piece.heading && index === 0, indent: piece.indent || !piece.heading, pages: [piece.page] }
        flow.push({ kind: 'paragraph', paragraph: last })
      }
    })
  }
  return flow
}

/** A line joined to the paragraph before it: a word hyphenated at the line's end is made whole. */
function joinLine(before: string, line: string): string {
  if (/\p{L}-$/u.test(before) && /^\p{Ll}/u.test(line)) return before.slice(0, -1) + line
  return `${before} ${line}`
}

function mode(values: number[]): number {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
}

/** The images painted on a page: how much of it each covers and how high (PDF points, from the bottom). */
async function imagesOn(doc: PDFDocumentProxy, number: number): Promise<{ area: number; y: number }[]> {
  const page = await doc.getPage(number)
  const ops = await page.getOperatorList()
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  const found: { area: number; y: number }[] = []
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i] as number[]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) {
      const [a0, b0, c0, d0, e0, f0] = ctm
      const [a1, b1, c1, d1, e1, f1] = args
      ctm = [a1 * a0 + b1 * c0, a1 * b0 + b1 * d0, c1 * a0 + d1 * c0, c1 * b0 + d1 * d0, e1 * a0 + f1 * c0 + e0, e1 * b0 + f1 * d0 + f0]
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      found.push({ area: Math.abs(ctm[0] * ctm[3]), y: ctm[5] + Math.abs(ctm[3]) / 2 })
    }
  })
  return found
}

/** How the translated text is set: the original's page size and body size. */
export interface NovelLayout {
  width: number
  height: number
  bodySize: number
}

/** The original's page size and body text size, from its first text page. */
export async function novelLayout(doc: PDFDocumentProxy, pages: number[]): Promise<NovelLayout> {
  for (const number of pages) {
    const page = await doc.getPage(number)
    const content = await page.getTextContent()
    const items = content.items.filter((it): it is TextItem => 'str' in it && it.str.trim().length > 0)
    if (items.reduce((n, it) => n + it.str.length, 0) < TEXT_PAGE) continue
    const { width, height } = page.getViewport({ scale: 1 })
    return { width, height, bodySize: Math.min(20, Math.max(10, mode(items.map((it) => Math.round(Math.abs(it.transform[3]) || it.height))))) }
  }
  const first = (await doc.getPage(pages[0] ?? 1)).getViewport({ scale: 1 })
  return { width: first.width, height: first.height, bodySize: 14 }
}

/**
 * The translated novel as a PDF: the paragraphs set justified on pages the size of the original, the
 * pictures copied from it as they are. A paragraph not translated (failed) keeps its original text.
 */
export async function buildNovelPdf(
  original: Uint8Array,
  flow: NovelFlow,
  translations: Map<number, string>,
  layout: NovelLayout,
  title: string
): Promise<Uint8Array> {
  const source = await PDFDocument.load(original, { ignoreEncryption: true })
  const out = await PDFDocument.create()
  out.setTitle(title)
  out.setCreator('Toon Index')
  const regular = await out.embedFont(StandardFonts.TimesRoman)
  const bold = await out.embedFont(StandardFonts.TimesRomanBold)
  const { width, height, bodySize } = layout
  const margin = { side: width * 0.1, top: height * 0.08, bottom: height * 0.08 }
  const lineHeight = bodySize * 1.45
  const textWidth = width - margin.side * 2

  // In an object: TypeScript would otherwise keep `page` narrowed to null across the calls that set it.
  const at = { page: null as PDFPage | null }
  let y = 0
  let pageNumber = 0
  const newPage = () => {
    at.page = out.addPage([width, height])
    pageNumber++
    y = height - margin.top
    const label = String(pageNumber)
    at.page.drawText(label, { x: (width - regular.widthOfTextAtSize(label, bodySize * 0.7)) / 2, y: margin.bottom / 2, size: bodySize * 0.7, font: regular, color: rgb(0.4, 0.4, 0.4) })
  }
  const room = (needed: number) => {
    if (!at.page || y - needed < margin.bottom) newPage()
  }

  for (const piece of flow) {
    if (piece.kind === 'picture') {
      const [copied] = await out.copyPages(source, [piece.page - 1])
      out.addPage(copied)
      pageNumber++
      at.page = null
      continue
    }
    if (piece.kind === 'break') {
      room(lineHeight * 2)
      const mark = '*   *   *'
      at.page!.drawText(mark, { x: (width - regular.widthOfTextAtSize(mark, bodySize)) / 2, y: y - lineHeight * 1.2, size: bodySize, font: regular })
      y -= lineHeight * 2
      continue
    }
    const { paragraph } = piece
    const text = printable(translations.get(paragraph.id) ?? paragraph.text, regular)
    if (paragraph.heading) {
      if (paragraph.newPage && at.page && y < height - margin.top) newPage()
      const size = bodySize * 1.35
      const lines = wrap(text, bold, size, textWidth)
      room(lines.length * size * 1.4 + lineHeight * 2)
      if (y < height - margin.top) y -= lineHeight
      for (const line of lines) {
        at.page!.drawText(line.words.join(' '), { x: (width - bold.widthOfTextAtSize(line.words.join(' '), size)) / 2, y: y - size, size, font: bold })
        y -= size * 1.4
      }
      y -= lineHeight
      continue
    }
    const indent = paragraph.indent ? bodySize * 1.5 : 0
    const lines = wrap(text, regular, bodySize, textWidth, indent)
    lines.forEach((line, i) => {
      room(lineHeight)
      const x = margin.side + (i === 0 ? indent : 0)
      const joined = line.words.join(' ')
      const spaces = line.words.length - 1
      // Justified: the gaps between words take up what is left of the line (not on the paragraph's last line).
      const spare = textWidth - (i === 0 ? indent : 0) - regular.widthOfTextAtSize(joined, bodySize)
      const spacing = i < lines.length - 1 && spaces > 0 && spare > 0 && spare < textWidth * 0.3 ? spare / spaces : 0
      if (spacing) at.page!.pushOperators(setWordSpacing(spacing))
      at.page!.drawText(joined, { x, y: y - bodySize, size: bodySize, font: regular })
      if (spacing) at.page!.pushOperators(setWordSpacing(0))
      y -= lineHeight
    })
  }
  if (!out.getPageCount()) newPage()
  return out.save()
}

/** Words broken into lines that fit `width` (the first `indent` narrower). */
function wrap(text: string, font: PDFFont, size: number, width: number, indent = 0): { words: string[] }[] {
  const lines: { words: string[] }[] = []
  let words: string[] = []
  let used = 0
  const space = font.widthOfTextAtSize(' ', size)
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = font.widthOfTextAtSize(word, size)
    const limit = width - (lines.length === 0 ? indent : 0)
    if (words.length && used + space + w > limit) {
      lines.push({ words })
      words = []
      used = 0
    }
    used += (words.length ? space : 0) + w
    words.push(word)
  }
  if (words.length) lines.push({ words })
  return lines
}

/** Quotes and dashes the standard PDF font has; anything it cannot draw is replaced or left out. */
const SUBSTITUTES: Record<string, string> = { '―': '—', '‐': '-', '‑': '-', '−': '-', '〜': '~', '～': '~', '「': '“', '」': '”', '『': '“', '』': '”', '♪': '', '★': '*', '☆': '*', '♥': '' }

function printable(text: string, font: PDFFont): string {
  const cache = printableCache.get(font) ?? new Map<string, string>()
  printableCache.set(font, cache)
  let out = ''
  for (const char of text.normalize('NFC')) {
    let kept = cache.get(char)
    if (kept === undefined) {
      const candidate = SUBSTITUTES[char] ?? char
      try {
        font.encodeText(candidate)
        kept = candidate
      } catch {
        kept = ''
      }
      cache.set(char, kept)
    }
    out += kept
  }
  return out
}

const printableCache = new Map<PDFFont, Map<string, string>>()
