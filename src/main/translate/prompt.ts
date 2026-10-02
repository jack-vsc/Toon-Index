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
    ? 'Also include sound effects / onomatopoeia (kind "sfx").'
    : 'Ignore sound effects / onomatopoeia drawn as part of the artwork; do not return them.'

  const multi = req.images.length > 1
  const sizes = req.images.map((img, i) => `image ${i}: ${img.width}x${img.height}`).join(', ')
  const intro = multi
    ? `The ${req.images.length} attached images are consecutive vertical slices of ONE long manga/webtoon page, ordered top to bottom. Sizes (width x height): ${sizes}.
Neighbouring slices may overlap. If a text block is cut by the top or bottom edge of a slice, skip it in that slice: it appears complete in the neighbouring slice.`
    : `The attached image is one manga/webtoon page, exactly ${sizes.replace('image 0: ', '')} pixels (width x height).`

  const marks = req.regions.length
    ? `Text detection software has drawn numbered magenta boxes on the image${multi ? 's' : ''}, each around a block of lettering it found; the number is on a magenta tag next to the box and is unique across all images. The software can be wrong: a box may surround artwork with no text, split one bubble into several boxes, or miss some text.`
    : 'Text detection software found no lettering on these images; it may have missed some.'

  return `You are a professional manga translator.

${intro}
${marks}
${source}
Translate every piece of readable text into ${settings.targetLanguage}.
${sfx}
Skip scanlation credits, watermarks and website URLs.

Return EVERY text block, including small bubbles, one-word bubbles and short interjections: a missed bubble stays untranslated.

For each text block (one speech bubble, thought bubble, narration box, system window or caption = one block) return:
- "image": index of the image the block is on.
- "box_2d": a bounding box [ymin, xmin, ymax, xmax] that tightly encloses all of the block's glyphs, normalized to 0-1000 relative to the height and width of that image. Always give it, also for text inside numbered boxes.
- "ids": the numbers of the boxes drawn around this block's text, or [] when it has none. List every box of the block when it was split. Only use a box that actually contains this text: never boxes of another bubble, boxes around artwork or bubble borders, or a nearby box for text that has no box of its own.
- "original": the original text.
- "translation": natural, fluent ${settings.targetLanguage}, matching the tone of the character. Keep it concise so it fits the bubble.
- "kind": "speech" (regular dialogue bubble), "thought" (inner monologue: cloud, fuzzy or dark bubble), "shout" (yelling: jagged burst bubble or big bold lettering), "narration" (caption box or text over the art), "system" (game-like system window, status screen or notification), "aside" (small side remark written next to a bubble or character), "sfx" (sound effect).
- "font": typeface of the original lettering: "comic" (standard comic lettering), "brush" (bold slanted marker/brush lettering), "condensed" (tall narrow sans-serif), "sans", "serif" or "handwritten" (small casual handwriting).
- "italic": true if the original lettering is slanted.
- "color": fill colour of the original letters as "#rrggbb".
- "outline": colour of the outline drawn around the original letters as "#rrggbb", or null if they have none.

List blocks in reading order. Images without text get no entries.

Respond with ONLY a JSON object, no markdown fences and no commentary, in exactly this shape:
{"blocks":[{"image":0,"box_2d":[0,0,0,0],"ids":[1],"original":"","translation":"","kind":"speech","font":"comic","italic":false,"color":"#000000","outline":null},{"image":0,"box_2d":[0,0,0,0],"ids":[],"original":"","translation":"","kind":"narration","font":"sans","italic":false,"color":"#ffffff","outline":"#000000"}]}`
}

const KINDS: BlockKind[] = ['speech', 'thought', 'shout', 'narration', 'system', 'aside', 'sfx', 'other']
const FONT_ROLES: FontRole[] = ['comic', 'brush', 'condensed', 'sans', 'serif', 'handwritten']

/** Returns one list of blocks per requested image, in the same order. */
export function parseBlocks(raw: string, req: TranslateRequest): TextBlock[][] {
  const json = extractJson(raw)
  const result: TextBlock[][] = req.images.map(() => [])
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
  for (const entry of entries) {
    const placed = toBlock(entry, req)
    if (placed) result[placed.image].push(placed.block)
  }
  return result
}

function toBlock(item: unknown, req: TranslateRequest): { image: number; block: TextBlock } | undefined {
  if (!item || typeof item !== 'object') return undefined
  const b = item as Record<string, unknown>
  const translation = typeof b.translation === 'string' ? b.translation.trim() : ''
  if (!translation) return undefined
  const placed = place(pickRegions(b.ids, req), fromBox(b, req), req)
  if (!placed) return undefined
  const { width, height } = req.images[placed.image]
  return {
    image: placed.image,
    block: {
      textBox: placed.box,
      areaBox: roomAround(placed.box, width, height),
      inkBoxes: placed.inkBoxes,
      original: typeof b.original === 'string' ? b.original : '',
      translation,
      kind: KINDS.includes(b.kind as BlockKind) ? (b.kind as BlockKind) : 'other',
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
 * The detected boxes the model picked give the exact position; its own box_2d is often off by a line or
 * more, so it never overrides them. It only drops picked boxes far from the text (another bubble, spikes)
 * when it agrees with some of them, and extends them when the detector caught part of the text.
 */
function place(
  picked: MarkedRegion[],
  guess: { image: number; box: Box } | undefined,
  req: TranslateRequest
): { image: number; box: Box; inkBoxes?: Box[] } | undefined {
  if (picked.length) {
    const image = guess && picked.some((r) => r.image === guess.image) ? guess.image : picked[0].image
    let chosen = picked.filter((r) => r.image === image)
    const box = guess?.image === image ? guess.box : undefined
    if (box) {
      const reach = Math.max(20, 0.25 * Math.max(box[2] - box[0], box[3] - box[1]))
      const near = [box[0] - reach, box[1] - reach, box[2] + reach, box[3] + reach] as Box
      const agreeing = chosen.filter((r) => overlapArea(r.box, near) > 0)
      if (agreeing.length) chosen = agreeing
    }
    const inkBoxes = chosen.map((r) => r.box)
    const found = unionAll(inkBoxes)
    const extended = box && union(found, box)
    if (box && extended && overlapArea(found, box) >= 0.5 * area(found) && area(extended) <= 3 * area(found)) {
      return { image, box: extended, inkBoxes }
    }
    return { image, box: found, inkBoxes }
  }
  if (!guess) return undefined
  const inside = req.regions.filter((r) => r.image === guess.image && overlapArea(r.box, guess.box) >= 0.5 * area(r.box))
  if (!inside.length) return guess
  const inkBoxes = inside.map((r) => r.box)
  return { image: guess.image, box: unionAll(inkBoxes), inkBoxes }
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

function area(b: Box): number {
  return Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
}

function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
