import {
  AUTO_LANGUAGE,
  type AppSettings,
  type BlockKind,
  type Box,
  type FontRole,
  type MarkedRegion,
  type TextBlock,
  type TranslateRequest
} from '../../shared/types'
import { FormatError } from './errors'
import { parseLenient } from './json'

export function buildPrompt(req: TranslateRequest, settings: AppSettings): string {
  const source =
    settings.sourceLanguage === AUTO_LANGUAGE
      ? 'Detect the source language automatically.'
      : `The source language is ${settings.sourceLanguage}.`
  const sfx = settings.translateSfx
    ? `Also include sound effects / onomatopoeia drawn in the artwork (kind "sfx"), Korean, Japanese and Chinese ones too: each sound effect is one block, and its "translation" is the onomatopoeia a ${settings.targetLanguage} letterer would draw instead (short, uppercase: a laugh, a gulp, a thud), never a description of the sound and never the original characters: a Korean, Japanese or Chinese sound effect is always rewritten in Latin letters.`
    : 'Ignore sound effects / onomatopoeia drawn as part of the artwork; do not return them.'

  const multi = req.images.length > 1
  const sizes = req.images.map((img, i) => `image ${i}: ${img.width}x${img.height}`).join(', ')
  const intro = multi
    ? `The first ${req.images.length} attached images are consecutive vertical slices of ONE long manga/webtoon page, ordered top to bottom. Sizes (width x height): ${sizes}.
Neighbouring slices overlap, so some text shows in two slices; it is boxed in only one of them, and is returned only once. If a text block is cut by the top or bottom edge of a slice, skip it in that slice: it appears complete in the neighbouring slice.`
    : `The first attached image is one manga/webtoon page, exactly ${sizes.replace('image 0: ', '')} pixels (width x height).`

  if (!req.regions.length) {
    return `You are a professional manga translator.

${intro}
${source}
Translate every piece of readable text into ${settings.targetLanguage}.
${sfx}
Scanlation watermarks, credits and website URLs written over the artwork (such as "YOU CAN FIND ALL CHAPTERS ON OUR WEBSITE: ...") are blocks of kind "watermark" with an empty translation: they are erased, not translated. A watermark sometimes runs into a bubble, its lines side by side with a character's words: then give two blocks listing the same boxes, the watermark, and the words alone (their original and translation without any of the watermark).

Return EVERY text block, including small bubbles, one-word bubbles and short interjections: a missed bubble stays untranslated.

For each text block (one speech bubble, thought bubble, narration box, system window or caption = one block) return:
- "image": index of the image the block is on.
- "box_2d": a bounding box [ymin, xmin, ymax, xmax] that tightly encloses all of the block's glyphs, normalized to 0-1000 relative to the height and width of that image.
${blockFields(settings.targetLanguage)}

List blocks in reading order. Images without text get no entries.

Respond with ONLY a JSON object, no markdown fences and no commentary, in exactly this shape:
{"blocks":[{"image":0,"box_2d":[0,0,0,0],${EXAMPLE_FIELDS}}]}`
  }

  const keyCount = req.key.length
  const keyImages = keyCount === 1 ? `image ${req.images.length}` : `images ${req.images.length}-${req.images.length + keyCount - 1}`
  return `You are a professional manga translator.

${intro}
Text detection software has drawn numbered magenta boxes on the page image${multi ? 's' : ''}, each around a block of lettering it found; the number is on a magenta tag next to the box and is unique across all images. The last attached ${keyCount === 1 ? 'image' : `${keyCount} images`} (${keyImages}) ${keyCount === 1 ? 'is' : 'are'} the key: every box cut out and enlarged, its number on the magenta tag at its left. Read the text of each box on the key; use the page for context (who speaks to whom, what is happening, which boxes share a bubble).
The software can be wrong: a box may surround artwork or a bubble's border with no text, one bubble may be split into several boxes, and some text may have no box.
${source}
Translate the text into ${settings.targetLanguage}.
${sfx}
Scanlation watermarks, credits and website URLs written over the artwork (such as "YOU CAN FIND ALL CHAPTERS ON OUR WEBSITE: ...") are blocks of kind "watermark" with an empty translation: they are erased, not translated. Korean, Japanese or Chinese writing left in the artwork of a page lettered in another language (shop signs, background writing, leftovers of the original edition) is part of the art: skip it${settings.translateSfx ? ', unless it is a sound effect' : ''}. Lettered text is always translated, system windows and status screens included.

Answer EVERY numbered box exactly once: put its number in the "ids" of the text block it belongs to, or in "skip" when it holds nothing to translate (artwork, a pattern, a bubble border, a sound effect that is not translated). A bubble whose text is split over several boxes is one block that lists all of them; the main bubble and a small line in its corner are always separate blocks. A box holding a watermark next to other lettering is two blocks that both list it: the watermark, and the other lettering on its own. Separate bubbles, captions and side remarks beside a bubble are separate blocks too. A box left out stays untranslated on the page.

For each text block (one speech bubble, thought bubble, narration box, system window or caption = one block) return:
- "ids": the numbers of the boxes holding this block's letters; never boxes that only hold the bubble's border, spikes or artwork around the text.
${blockFields(settings.targetLanguage)}

Text with no box at all (check the page for bubbles and captions without a magenta box) is a block with "ids": [] and also:
- "image": index of the page image it is on.
- "box_2d": a bounding box [ymin, xmin, ymax, xmax] that tightly encloses its glyphs, normalized to 0-1000 relative to the height and width of that image.

List blocks in reading order.

Respond with ONLY a JSON object, no markdown fences and no commentary, in exactly this shape:
{"skip":[3],"blocks":[{"ids":[1,2],${EXAMPLE_FIELDS}},{"ids":[],"image":0,"box_2d":[0,0,0,0],${EXAMPLE_FIELDS}}]}`
}

/** Asks again for boxes the model left out of its answer, showing only the key. */
export function buildFollowUp(ids: number[], req: TranslateRequest, settings: AppSettings): string {
  const source =
    settings.sourceLanguage === AUTO_LANGUAGE
      ? 'Detect the source language automatically.'
      : `The source language is ${settings.sourceLanguage}.`
  return `You are a professional manga translator.

The attached image${req.key.length > 1 ? 's show' : ' shows'} blocks of lettering cut out of a manga/webtoon page, each with its number on a magenta tag at its left. ${source}
Translate the text of boxes ${ids.join(', ')} into ${settings.targetLanguage}; ignore the other boxes.
Answer each of these boxes exactly once: put its number in the "ids" of a text block, or in "skip" when it holds nothing to translate (artwork, a pattern, a bubble border${settings.translateSfx ? '' : ', a sound effect'}); a watermark is a block of kind "watermark". Boxes that are parts of one sentence or bubble form one block that lists all of them.

For each text block return:
- "ids": the numbers of the boxes holding this block's text.
${blockFields(settings.targetLanguage)}

Respond with ONLY a JSON object, no markdown fences and no commentary, in exactly this shape:
{"skip":[],"blocks":[{"ids":[${ids[0] ?? 1}],${EXAMPLE_FIELDS}}]}`
}

function blockFields(target: string): string {
  return `- "original": the original text.
- "translation": natural, fluent ${target}, matching the tone of the character. Keep it concise so it fits the bubble.
- "kind": "speech" (regular dialogue bubble), "thought" (inner monologue: cloud, fuzzy or dark bubble), "shout" (yelling: jagged burst bubble or big bold lettering), "whisper" (said quietly: dashed or faint bubble, small light lettering), "narration" (caption box with a flat background), "system" (game-like system window, status screen or notification), "aside" (small remark in the corner of a bubble or beside a character, always its own block), "signage" (a sign, building name or label drawn on the artwork, such as a hospital or shop front; the translation is shown below the panel, not over the art), "sfx" (sound effect), "watermark" (a scanlation group's watermark, credit or website, to be erased).
- "font": typeface of the original lettering: "comic" (standard comic lettering), "brush" (bold slanted marker/brush lettering), "condensed" (tall narrow sans-serif), "sans", "serif" or "handwritten" (small casual handwriting).
- "italic": true if the original lettering is slanted.
- "color": fill colour of the original letters as "#rrggbb".
- "outline": colour of the outline drawn around the original letters as "#rrggbb", or null if they have none.`
}

const EXAMPLE_FIELDS = '"original":"","translation":"","kind":"speech","font":"comic","italic":false,"color":"#000000","outline":null'

const KINDS: BlockKind[] = ['speech', 'thought', 'shout', 'whisper', 'narration', 'system', 'aside', 'signage', 'sfx', 'watermark', 'other']
/** A web address: lettering that names one is a scanlation group's watermark, whatever the model calls it. */
const WEBSITE = /\b[a-z0-9-]+\.(?:com|net|org|io|co|me|to|gg|cc|xyz|site|online|club|info)\b/i

const FONT_ROLES: FontRole[] = ['comic', 'brush', 'condensed', 'sans', 'serif', 'handwritten']

/**
 * Returns one list of blocks per requested image, in the same order, and the boxes the answer
 * accounted for. `boxedOnly` drops blocks placed by the model's own box (follow-ups only show the key).
 */
export function parseBlocks(
  raw: string,
  req: TranslateRequest,
  boxedOnly = false
): { blocks: TextBlock[][]; answered: Set<number>; skipped: Set<number> } {
  const json = extractJson(raw)
  const result: TextBlock[][] = req.images.map(() => [])
  const answered = new Set<number>()
  const skipped = new Set<number>()
  for (const id of Array.isArray(json?.skip) ? json.skip : []) answered.add(Number(id)), skipped.add(Number(id))
  // Also accepts blocks grouped per image, which some models fall back to.
  const entries: unknown[] = Array.isArray(json?.blocks)
    ? json.blocks
    : Array.isArray(json?.images)
      ? json.images.flatMap((group: { image?: unknown; blocks?: unknown }) =>
          Array.isArray(group?.blocks) ? group.blocks.map((b: object) => ({ image: group.image, ...b })) : []
        )
      : Array.isArray(json)
        ? json
        : []
  if (!boxedOnly) realignIds(entries, req)
  // A bubble in the overlap of two slices is sometimes returned for both, the second time on whatever
  // box lies near it there; the copy on more letters is the real one.
  const seen = new Map<string, { image: number; block: TextBlock; glyphs: number }>()
  for (const entry of entries) {
    const picked = entry && typeof entry === 'object' ? pickRegions((entry as Record<string, unknown>).ids, req) : []
    if (boxedOnly && !picked.length) continue
    // A translation stuck repeating itself ("E A E E E E…") is no answer: its boxes are asked about
    // again on their own, and the text would take the overlay minutes to lay out.
    if (looping((entry as Record<string, unknown>).translation)) continue
    const placed = toBlock(entry, picked, req)
    // Boxes the block's position left out (not next to its text) are asked about again on their own.
    for (const r of placed ? placed.kept : picked) answered.add(r.id)
    if (!placed) continue
    const glyphs = placed.kept.reduce((n, r) => n + r.glyphs, 0)
    // A long translation given twice is one bubble's text put on other boxes as well (background
    // writing in another script, artwork) too.
    const original = 'o:' + placed.block.original.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const translation = 't:' + placed.block.translation.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const keys = [original.length >= 5 ? original : '', translation.length >= 17 ? translation : ''].filter(Boolean)
    const live = (key: string) => {
      const t = seen.get(key)
      return t && result[t.image].includes(t.block) ? t : undefined
    }
    const sameText = keys.includes(original) ? live(original) : undefined
    const twin = (sameText && sameText.image !== placed.image ? sameText : undefined) ?? (keys.includes(translation) ? live(translation) : undefined)
    if (twin) {
      if (twin.glyphs >= glyphs) continue
      result[twin.image].splice(result[twin.image].indexOf(twin.block), 1)
    }
    for (const key of keys) seen.set(key, { image: placed.image, block: placed.block, glyphs })
    result[placed.image].push(placed.block)
  }
  return { blocks: result, answered, skipped }
}

/**
 * Small models now and then lose count of the boxes partway through a page: from one block on, each
 * text comes with the number of the box after (or before) its own, and every bubble gets its
 * neighbour's words. The detector measured how many letters each box holds; when the texts from some
 * block on fit the boxes one number off far better than the ones given, those blocks move over.
 */
export function realignIds(entries: unknown[], req: TranslateRequest): void {
  // Boxes of a stray mark or two are skipped when counting: the model loses count over real ones.
  const order = req.regions.filter((r) => r.glyphs >= MIN_COUNTED_GLYPHS).sort((a, b) => a.id - b.id)
  const at = new Map(order.map((r, i) => [r.id, i]))
  const rows = entries
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
    .filter((e): e is Record<string, unknown> => !!e && typeof e.original === 'string' && Array.isArray(e.ids))
    .map((e) => ({
      entry: e,
      places: (e.ids as unknown[]).map((id) => at.get(Number(id))).filter((p): p is number => p !== undefined),
      letters: letterCount(e.original as string)
    }))
    .filter((r) => r.letters >= 4 && r.places.length > 0)
  if (rows.length < 3) return
  // How far a text's length is from what the boxes hold (by ratio, so long and short count alike).
  const cost = (row: (typeof rows)[number], shift: number): number => {
    const places = row.places.map((p) => p + shift)
    if (places.some((p) => p < 0 || p >= order.length)) return Infinity
    const glyphs = places.reduce((n, p) => n + order[p].glyphs, 0)
    return Math.min(3, Math.abs(Math.log((row.letters + 4) / (glyphs + 4))))
  }
  const given = rows.map((r) => cost(r, 0))
  // A run of blocks that each clearly don't fit the boxes given and fit the next ones better. It ends
  // where the count is right again: a block that fits its own boxes stays (a bubble split over two
  // boxes fits either, so only clear misfits tell).
  let best = { from: -1, to: -1, shift: 0, saved: 0, before: 0, after: 0 }
  for (const shift of [1, -1]) {
    const moved = rows.map((r) => cost(r, shift))
    for (let from = 0; from < rows.length; from++) {
      let before = 0
      let after = 0
      for (let to = from + 1; to <= rows.length && given[to - 1] >= MISFIT && moved[to - 1] < given[to - 1]; to++) {
        before += given[to - 1]
        after += moved[to - 1]
        if (to - from >= 2 && before - after > best.saved) best = { from, to, shift, saved: before - after, before, after }
      }
    }
  }
  // Clearly better: the texts fit the moved boxes twice as well.
  if (best.from < 0 || best.saved < 1.5 || best.after > 0.5 * best.before) return
  for (const row of rows.slice(best.from, best.to)) row.entry.ids = row.places.map((p) => order[p + best.shift].id)
  console.warn(`[translate] box numbers off by ${best.shift} for blocks ${best.from + 1}-${best.to} of ${rows.length}: moved`)
}

const MIN_COUNTED_GLYPHS = 3
/** Text and boxes this far apart in length (log of the ratio: about 1.65 times) don't go together. */
const MISFIT = 0.5

function letterCount(text: string): number {
  return text.replace(/[^\p{L}\p{N}]/gu, '').length
}

/** A word or a few repeated back to back many times over, or far more text than any bubble holds. */
export function looping(translation: unknown): boolean {
  if (typeof translation !== 'string') return false
  return /((?:\S+\s+){1,3}?)\1{9,}/u.test(translation + ' ') || translation.length > 1200
}

function toBlock(
  item: unknown,
  picked: MarkedRegion[],
  req: TranslateRequest
): { image: number; block: TextBlock; kept: MarkedRegion[] } | undefined {
  if (!item || typeof item !== 'object') return undefined
  const b = item as Record<string, unknown>
  const original = typeof b.original === 'string' ? b.original : ''
  const watermark = b.kind === 'watermark' || WEBSITE.test(original)
  const translation = watermark ? '' : typeof b.translation === 'string' ? b.translation.trim() : ''
  if (!translation && !watermark) return undefined
  const words = original.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  const placed = place(picked, fromBox(b, req), words)
  if (!placed) return undefined
  const { width, height } = req.images[placed.image]
  return {
    image: placed.image,
    kept: placed.kept,
    block: {
      textBox: placed.box,
      areaBox: roomAround(placed.box, width, height),
      inkBoxes: placed.inkBoxes,
      letterHeight: placed.letterHeight,
      original,
      translation,
      kind: watermark ? 'watermark' : KINDS.includes(b.kind as BlockKind) ? (b.kind as BlockKind) : 'other',
      font: FONT_ROLES.includes(b.font as FontRole) ? (b.font as FontRole) : undefined,
      italic: typeof b.italic === 'boolean' ? b.italic : undefined,
      color: toHex(b.color),
      outline: toHex(b.outline)
    }
  }
}

function pickRegions(ids: unknown, req: TranslateRequest): MarkedRegion[] {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger)
  return list.map((id) => req.regions.find((r) => r.id === id)).filter((r) => r !== undefined)
}

/**
 * The detected boxes the model picked give the exact position. The model's own box_2d (often off by a
 * line or more) only places text the detector missed, and the overlay looks for the glyphs around it.
 */
function place(
  picked: MarkedRegion[],
  guess: { image: number; box: Box } | undefined,
  words: number
): { image: number; box: Box; kept: MarkedRegion[]; inkBoxes?: Box[]; letterHeight?: number } | undefined {
  if (!picked.length) return guess && { ...guess, kept: [] }
  // Overlapping slices number the same text twice; a block keeps the slice most of its boxes are on.
  const counts = new Map<number, number>()
  for (const r of picked) counts.set(r.image, (counts.get(r.image) ?? 0) + 1)
  const image = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const onImage = picked.filter((r) => r.image === image)
  // The detector already joins the lines of one bubble; other boxes the model adds are bubble spikes or
  // artwork beside the text, unless they continue it right away.
  const kept = [onImage.reduce((a, b) => (b.glyphs > a.glyphs ? b : a))]
  for (let grew = true; grew; ) {
    grew = false
    for (const r of onImage) {
      if (!kept.includes(r) && kept.some((k) => continues(k, r))) kept.push(r), (grew = true)
    }
  }
  // Every word is at least one piece of ink: far fewer pieces than words is a box beside the text the
  // model read (a bubble's spiky border next to a small remark, a face), and lettering it there would be
  // the wrong size. Longer text may come in half as many pieces, its small lines run together into one
  // band (chapter 53: a status window 26 pieces for 47 words, a face 3 for 7); a remark of a word or two
  // must not, being exactly what a border spike passes for ("READING DRONE." on one).
  const pieces = kept.reduce((n, r) => n + r.glyphs, 0)
  if (words <= 2 ? pieces < words : pieces * 2 < words) return undefined
  const inkBoxes = kept.map((r) => r.box)
  const letterHeight = Math.max(...kept.map((r) => r.letterHeight))
  return { image, box: unionAll(inkBoxes), kept: [...kept, ...picked.filter((r) => r.image !== image)], inkBoxes, letterHeight }
}

/** Whether `b` is the next line of `a`, or the rest of its line. */
function continues(a: MarkedRegion, b: MarkedRegion): boolean {
  const lo = Math.min(a.letterHeight, b.letterHeight)
  const hi = Math.max(a.letterHeight, b.letterHeight)
  if (hi > 1.8 * lo) return false
  const gapX = Math.max(0, b.box[0] - a.box[2], a.box[0] - b.box[2])
  const gapY = Math.max(0, b.box[1] - a.box[3], a.box[1] - b.box[3])
  const overlapX = Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0])
  const overlapY = Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1])
  const minW = Math.min(a.box[2] - a.box[0], b.box[2] - b.box[0])
  return (gapY <= 1.5 * hi && overlapX >= 0.3 * minW) || (overlapY >= 0.5 * lo && gapX <= 2 * hi)
}

function fromBox(b: Record<string, unknown>, req: TranslateRequest): { image: number; box: Box } | undefined {
  const image = Number.isInteger(b.image) ? (b.image as number) : 0
  const size = req.images[image]
  const box = size && toBox(b.box_2d, size.width, size.height)
  return box ? { image, box } : undefined
}

/** The overlay measures the bubble itself; this only bounds how far it looks. */
function roomAround(box: Box, width: number, height: number): Box {
  const w = box[2] - box[0]
  const h = box[3] - box[1]
  const px = Math.max(16, w * 0.3)
  const py = Math.max(16, h * 0.6)
  return [clamp(box[0] - px, 0, width), clamp(box[1] - py, 0, height), clamp(box[2] + px, 0, width), clamp(box[3] + py, 0, height)]
}

function toHex(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined
}

function extractJson(raw: string): any {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.search(/[[{]/)
  if (start === -1) {
    throw new FormatError(`A IA não retornou JSON válido. Resposta: ${raw.slice(0, 300)}`)
  }
  try {
    return parseLenient(cleaned.slice(start))
  } catch (err) {
    throw new FormatError(`Falha ao ler o JSON da IA: ${(err as Error).message}. Resposta: ${raw.slice(0, 300)}`)
  }
}

/** Converts a normalized [ymin, xmin, ymax, xmax] (0-1000) box into pixel [x0, y0, x1, y1]. */
function toBox(value: unknown, width: number, height: number): Box | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  const n = value.map(Number)
  if (n.some((v) => !Number.isFinite(v))) return undefined
  const y0 = clamp((Math.min(n[0], n[2]) / 1000) * height, 0, height)
  const y1 = clamp((Math.max(n[0], n[2]) / 1000) * height, 0, height)
  const x0 = clamp((Math.min(n[1], n[3]) / 1000) * width, 0, width)
  const x1 = clamp((Math.max(n[1], n[3]) / 1000) * width, 0, width)
  if (x1 - x0 < 2 || y1 - y0 < 2) return undefined
  return [x0, y0, x1, y1]
}

function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

function unionAll(boxes: Box[]): Box {
  return boxes.reduce(union)
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
