import type { Box, EvalConfig, TextBlock } from '../../../shared/types'
import type { OverlayInfo } from './overlay'
import { canvasToBytes } from './pdf'
import { TranslationJob } from './pipeline'

/** Width of the grey thumbnails pages are aligned on. */
const THUMB_W = 100
/** Accepted mean grey difference between a page window and the reference. */
const MATCH_LIMIT = 22
const COLUMN = 380
const MAX_ITEM_H = 420
const LABEL_H = 40
const GAP = 8
const SHEET_MAX_H = 2200

interface Reference {
  images: ImageBitmap[]
  /** Top of each image in the continuous strip, in reference pixels. */
  tops: number[]
  width: number
  thumb: Uint8Array
  thumbH: number
}

interface Item {
  rect: Box
  label: string
  marks: { box: Box; color: string }[]
  translated: boolean
}

/**
 * Translates the sample pages with the current settings and, for every block and every detected
 * region left untranslated, saves the original, the app's result and the hand translation side by side.
 */
export async function runEvaluation(config: EvalConfig): Promise<void> {
  const api = window.api.evaluation
  const log = (message: string) => void api.log(message)
  try {
    const settings = await window.api.getSettings()
    const reference = config.reference.length ? await loadReference(config.reference) : null
    log(`reference: ${config.reference.length} images, ${reference?.thumbH ?? 0} thumbnail rows`)
    const job = await TranslationJob.open(await api.read(config.pdf), () => {})
    const pages = config.pages ?? Array.from({ length: job.numPages }, (_, i) => i + 1)
    await job.select(pages)
    const summary: Record<string, unknown>[] = []
    job.onPageRendered = async (n, before, after, regions, drawn) => {
      const blocks = job.blocks.get(n) ?? []
      const pad = String(n).padStart(2, '0')
      const items = collectItems(n, blocks, regions, drawn, before.width, before.height)
      const pageThumb = reference ? thumbnail(before) : null
      let matched = 0
      const sheets: HTMLCanvasElement[] = []
      let sheet: { item: Item; ref: Box | null }[] = []
      const flush = () => sheet.length && (sheets.push(drawSheet(sheet, before, after, reference)), (sheet = []))
      let height = 0
      for (const item of items) {
        const ref = reference && pageThumb ? locate(item.rect, before.width, pageThumb, reference) : null
        if (ref) matched++
        const h = itemHeight(item.rect)
        if (height + h > SHEET_MAX_H) flush(), (height = 0)
        sheet.push({ item, ref })
        height += h + GAP
      }
      flush()
      for (const [i, canvas] of sheets.entries()) {
        await api.write(`p${pad}-${i + 1}.jpg`, await canvasToBytes(canvas, 'image/jpeg', 0.85))
      }
      await api.write(`p${pad}-before.png`, await canvasToBytes(before, 'image/png'))
      await api.write(`p${pad}-after.png`, await canvasToBytes(after, 'image/png'))
      const info = {
        page: n,
        blocks: blocks.length,
        guessed: blocks.filter((b) => !b.inkBoxes).length,
        orphans: items.filter((i) => !i.translated).length,
        matched,
        items: items.length
      }
      summary.push(info)
      log(JSON.stringify(info))
      await api.write(
        `p${pad}.json`,
        JSON.stringify(
          {
            ...info,
            regions: regions.map(round),
            blocks: blocks.map((b, i) => ({
              ...b,
              textBox: round(b.textBox),
              areaBox: round(b.areaBox),
              inkBoxes: b.inkBoxes?.map(round),
              overlay: drawn[i]
            }))
          },
          null,
          1
        )
      )
    }
    await job.run(settings.concurrency)
    for (const page of job.pages) if (page.status === 'error') log(`page ${page.number} failed: ${page.error?.message} ${page.error?.detail ?? ''}`)
    await api.write('summary.json', JSON.stringify(summary, null, 1))
  } catch (err) {
    log(`FAILED: ${(err as Error).stack ?? err}`)
  } finally {
    await api.done()
  }
}

/** Every block, plus every detected region no block covers (text the model skipped). */
function collectItems(n: number, blocks: TextBlock[], regions: Box[], drawn: OverlayInfo[], W: number, H: number): Item[] {
  const items: Item[] = blocks.map((b, i) => ({
    rect: clampBox(expand(union(b.textBox, b.areaBox), 30), W, H),
    label: `p${n} #${i + 1} ${b.kind} ${b.inkBoxes ? 'detected' : 'GUESSED'} ${describe(drawn[i])} | ${oneLine(b.original)} => ${oneLine(b.translation)}`,
    marks: [{ box: b.textBox, color: '#00c853' }, ...(b.inkBoxes ?? []).map((box) => ({ box, color: '#ff00cc' }))],
    translated: true
  }))
  for (const r of regions) {
    const covered = blocks.some((b) => [b.textBox, ...(b.inkBoxes ?? [])].some((box) => overlap(box, r) > 0.3 * area(r)))
    if (covered) continue
    items.push({
      rect: clampBox(expand(r, 60), W, H),
      label: `p${n} ORPHAN: detected text that got no translation`,
      marks: [{ box: r, color: '#ff1744' }],
      translated: false
    })
  }
  return items.sort((a, b) => a.rect[1] - b.rect[1])
}

function itemHeight(rect: Box): number {
  return Math.round((rect[3] - rect[1]) * itemScale(rect)) + LABEL_H
}

function itemScale(rect: Box): number {
  return Math.min(COLUMN / (rect[2] - rect[0]), MAX_ITEM_H / (rect[3] - rect[1]), 1.5)
}

function drawSheet(rows: { item: Item; ref: Box | null }[], before: HTMLCanvasElement, after: HTMLCanvasElement, reference: Reference | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = COLUMN * 3 + GAP * 4
  canvas.height = rows.reduce((h, r) => h + itemHeight(r.item.rect) + GAP, GAP)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#202124'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let y = GAP
  for (const { item, ref } of rows) {
    const [x0, y0, x1, y1] = item.rect
    const s = itemScale(item.rect)
    const w = Math.round((x1 - x0) * s)
    const h = Math.round((y1 - y0) * s)
    ctx.fillStyle = item.translated ? '#e8eaed' : '#ff8a80'
    ctx.font = '13px sans-serif'
    wrapText(ctx, item.label, GAP, y + 14, canvas.width - 2 * GAP, 16, 2)
    const top = y + LABEL_H
    ctx.drawImage(before, x0, y0, x1 - x0, y1 - y0, GAP, top, w, h)
    for (const m of item.marks) {
      ctx.strokeStyle = m.color
      ctx.lineWidth = 2
      ctx.strokeRect(GAP + (m.box[0] - x0) * s, top + (m.box[1] - y0) * s, (m.box[2] - m.box[0]) * s, (m.box[3] - m.box[1]) * s)
    }
    ctx.drawImage(after, x0, y0, x1 - x0, y1 - y0, COLUMN + 2 * GAP, top, w, h)
    if (ref && reference) drawReference(ctx, reference, ref, 2 * COLUMN + 3 * GAP, top, w, h)
    else {
      ctx.fillStyle = '#9aa0a6'
      ctx.fillText('(sem trecho correspondente na scan)', 2 * COLUMN + 3 * GAP, top + 20)
    }
    y += itemHeight(item.rect) + GAP
  }
  return canvas
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineH: number, maxLines: number): void {
  let line = ''
  let lines = 0
  for (const char of text) {
    if (ctx.measureText(line + char).width > width) {
      ctx.fillText(line, x, y + lines * lineH)
      if (++lines >= maxLines) return
      line = ''
    }
    line += char
  }
  ctx.fillText(line, x, y + lines * lineH)
}

// ---------------------------------------------------------------------------------------------------
// Reference alignment
// ---------------------------------------------------------------------------------------------------

async function loadReference(paths: string[]): Promise<Reference> {
  const images: ImageBitmap[] = []
  for (const path of paths) images.push(await createImageBitmap(new Blob([(await window.api.evaluation.read(path)) as BlobPart])))
  const width = images[0].width
  const tops: number[] = []
  let total = 0
  for (const img of images) tops.push(total), (total += (img.height * width) / img.width)
  const thumbH = Math.round((total * THUMB_W) / width)
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_W
  canvas.height = thumbH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  images.forEach((img, i) => ctx.drawImage(img, 0, (tops[i] * THUMB_W) / width, THUMB_W, (img.height * THUMB_W) / img.width))
  return { images, tops, width, thumb: toGray(ctx.getImageData(0, 0, THUMB_W, thumbH).data), thumbH }
}

function thumbnail(page: HTMLCanvasElement): { gray: Uint8Array; h: number; scale: number } {
  const scale = THUMB_W / page.width
  const h = Math.round(page.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_W
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(page, 0, 0, THUMB_W, h)
  return { gray: toGray(ctx.getImageData(0, 0, THUMB_W, h).data), h, scale }
}

/**
 * Finds where the art around `rect` is in the reference strip (the lettering differs, the art does
 * not) and returns the same area in reference pixels, or null when nothing matches well.
 */
function locate(rect: Box, pageW: number, page: { gray: Uint8Array; h: number; scale: number }, ref: Reference): Box | null {
  const cy = ((rect[1] + rect[3]) / 2) * page.scale
  const half = Math.max(40, (rect[3] - rect[1]) * page.scale)
  const winH = Math.min(page.h, Math.round(2 * half))
  const y0 = Math.round(Math.min(Math.max(0, cy - half), page.h - winH))
  if (winH < 20 || winH > ref.thumbH) return null
  let best = Infinity
  let bestAt = -1
  for (let at = 0; at + winH <= ref.thumbH; at++) {
    let sum = 0
    for (let y = 0; y < winH && sum < best; y += 2) {
      const a = (y0 + y) * THUMB_W
      const b = (at + y) * THUMB_W
      for (let x = 0; x < THUMB_W; x += 2) sum += Math.abs(page.gray[a + x] - ref.thumb[b + x])
    }
    if (sum < best) (best = sum), (bestAt = at)
  }
  const mean = best / (Math.ceil(winH / 2) * (THUMB_W / 2))
  if (mean > MATCH_LIMIT) return null
  const toRef = ref.width / THUMB_W
  const shift = (bestAt - y0) * toRef
  const k = ref.width / pageW
  return [rect[0] * k, rect[1] * page.scale * toRef + shift, rect[2] * k, rect[3] * page.scale * toRef + shift]
}

function drawReference(ctx: CanvasRenderingContext2D, ref: Reference, box: Box, dx: number, dy: number, dw: number, dh: number): void {
  const s = dh / (box[3] - box[1])
  ref.images.forEach((img, i) => {
    const k = img.width / ref.width
    const top = ref.tops[i]
    const bottom = top + img.height / k
    const y0 = Math.max(box[1], top)
    const y1 = Math.min(box[3], bottom)
    if (y1 <= y0) return
    ctx.drawImage(img, box[0] * k, (y0 - top) * k, (box[2] - box[0]) * k, (y1 - y0) * k, dx, dy + (y0 - box[1]) * s, dw, (y1 - y0) * s)
  })
}

function toGray(d: Uint8ClampedArray): Uint8Array {
  const gray = new Uint8Array(d.length / 4)
  for (let p = 0; p < gray.length; p++) gray[p] = (d[p * 4] * 77 + d[p * 4 + 1] * 150 + d[p * 4 + 2] * 29) >> 8
  return gray
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

function describe(info: OverlayInfo | undefined): string {
  if (!info) return ''
  if (!info.drawn) return '(not drawn)'
  return `[glyphs ${Math.round(info.letterHeight)}px, cap ${info.capHeight}px, font ${info.fontSize}px]`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function round(b: Box): Box {
  return b.map(Math.round) as Box
}

function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

function expand(b: Box, pad: number): Box {
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]
}

function clampBox(b: Box, w: number, h: number): Box {
  return [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(w, b[2]), Math.min(h, b[3])]
}

function area(b: Box): number {
  return Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
}

function overlap(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
}
