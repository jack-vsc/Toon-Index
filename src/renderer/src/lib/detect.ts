import type { Box } from '../../../shared/types'
import { components, dilate, erode, isGlyph, odd, quantile, type Comp } from './glyphs'

/** Local contrast of ink pixels: strong ones make up glyphs, weak ones are their anti-aliased edges. */
const INK_STRONG = 45
const INK_WEAK = 22
/** Beyond this many blocks on one image the detector is reading a texture; the best ones are kept. */
const MAX_REGIONS = 40
const MARK_COLOR = '#ff00cc'
/** Background tolerance for single letters: looser than the overlay's, the block tests catch artwork. */
const GLYPH_TOLERANCE = 45
/** Max grey-level distance from the block's background median to count as the same flat colour. */
const BLOCK_TOLERANCE = 30

export interface TextRegion {
  /** Tight box around the glyphs, in pixels of the image. */
  box: Box
  letterHeight: number
  glyphs: number
}

/**
 * Finds the blocks of lettering on an image by itself, so text positions never depend on the model:
 * thin strokes on flat background (black-hat for dark text, top-hat for light text), grouped into lines
 * of similar glyphs side by side, lines stacked into blocks. Artwork that passes these tests is harmless:
 * the model leaves boxes without readable text out.
 */
export function detectText(canvas: HTMLCanvasElement): TextRegion[] {
  const W = canvas.width
  const H = canvas.height
  if (W < 16 || H < 16) return []
  const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data
  const gray = new Uint8Array(W * H)
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8

  // The filter must be wider than the thickest strokes of ordinary lettering.
  const k = odd(Math.min(41, Math.max(11, Math.round(W / 35))))
  const closing = erode(dilate(gray, W, H, k), W, H, k)
  const opening = dilate(erode(gray, W, H, k), W, H, k)
  const minH = Math.max(5, W * 0.008)
  // Shouts are lettered up to about a seventh of the page width tall.
  const maxH = W * 0.15

  const found: TextRegion[] = []
  for (const dark of [true, false]) {
    const ink = new Uint8Array(W * H)
    const strong = new Uint8Array(W * H)
    for (let p = 0; p < gray.length; p++) {
      const c = dark ? closing[p] - gray[p] : gray[p] - opening[p]
      ink[p] = c > INK_WEAK ? 1 : 0
      strong[p] = c > INK_STRONG ? 1 : 0
    }
    const { labels, comps } = components(strong, W, H)
    const shapes = comps.filter(
      (c) =>
        c.count >= 3 &&
        c.h >= minH &&
        c.h <= maxH &&
        c.w <= W * 0.5 &&
        // Lettering is inset from the page sides; what touches them is artwork running off the page.
        c.x0 > 0 &&
        c.x1 < W &&
        c.w <= c.h * 10 + 4 &&
        c.h <= c.w * 8 + 4 &&
        // Outlines and speed lines are thin strokes spread over a large box.
        c.count >= c.w * c.h * 0.1 &&
        // A wide piece must be a word whose letters touch: several strokes across, unlike a spike.
        (c.w < 2 * c.h || strokesAcross(c, labels, W) >= 3) &&
        !isTip(c, gray, ink, labels, W, H)
    )
    const clean = new Set(shapes.filter((c) => isGlyph(c, gray, ink, labels, W, H, GLYPH_TOLERANCE)))
    for (const block of groupBlocks(shapes, clean)) {
      if (isTextBlock(block, gray, ink, W, H) && !besideOwnColour(block, gray, labels, W, H)) {
        found.push({ box: block.box, letterHeight: block.letterHeight, glyphs: block.glyphs })
      }
    }
  }
  return joinBubbles(mergeRegions(found), gray, W, H)
    .sort((a, b) => b.glyphs - a.glyphs)
    .slice(0, MAX_REGIONS)
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
}

/**
 * Lines of similar glyphs side by side, then lines of similar height stacked and aligned. Glow or
 * texture behind lettering can make single letters fail the flat-background test (`clean`); they still
 * count when they line up with letters that passed it.
 */
function groupBlocks(shapes: Comp[], clean: Set<Comp>): (TextRegion & { list: Comp[] })[] {
  const sorted = [...shapes].sort((a, b) => a.y0 - b.y0)
  const parent = sorted.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]
      if (b.y0 >= a.y1) break
      const lo = Math.min(a.h, b.h)
      const hi = Math.max(a.h, b.h)
      const sameRow = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) >= 0.5 * lo && hi <= 1.8 * lo
      if (sameRow && gapX(a, b) <= 0.9 * hi) parent[find(i)] = find(j)
    }
  }
  const byRoot = new Map<number, Comp[]>()
  sorted.forEach((c, i) => byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), c]))
  // A word whose letters touch is one wide component; anything else needs two glyphs to be a line.
  const lines = [...byRoot.values()]
    .map((list) => {
      // Doubtful pieces only count between clean letters, never as the ends of a line.
      const row = [...list].sort((a, b) => a.x0 - b.x0)
      const first = row.findIndex((c) => clean.has(c))
      const last = row.findLastIndex((c) => clean.has(c))
      return first < 0 ? [] : row.slice(first, last + 1)
    })
    .filter((list) => list.length && list.filter((c) => clean.has(c)).length >= list.length * 0.25)
    .map((list) => ({ list, box: boundsOf(list), h: quantile(list.map((c) => c.h), 0.6) }))
    .filter((l) => (l.list.length >= 2 && l.box[2] - l.box[0] >= l.h) || l.box[2] - l.box[0] >= 1.5 * l.h)
    .filter((l) => isAligned(l.list, l.h))
    .sort((a, b) => a.box[1] - b.box[1])

  const stack = lines.map((_, i) => i)
  const top = (i: number): number => (stack[i] === i ? i : (stack[i] = top(stack[i])))
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j]
      const lo = Math.min(a.h, b.h)
      const hi = Math.max(a.h, b.h)
      const dy = b.box[1] - a.box[3]
      // Lines are sorted by top and a stackable line is at most 1.3x taller than `a`.
      if (dy > 1.7 * a.h) break
      if (hi > 1.3 * lo || dy > 1.2 * hi || dy < -0.3 * lo) continue
      const overlapX = Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0])
      const minW = Math.min(a.box[2] - a.box[0], b.box[2] - b.box[0])
      const centred = Math.abs((a.box[0] + a.box[2]) / 2 - (b.box[0] + b.box[2]) / 2) <= Math.max(a.box[2] - a.box[0], b.box[2] - b.box[0]) * 0.25
      if (overlapX >= 0.3 * minW || centred) stack[top(i)] = top(j)
    }
  }
  const blocks = new Map<number, Comp[]>()
  lines.forEach((line, i) => blocks.set(top(i), [...(blocks.get(top(i)) ?? []), ...line.list]))
  return [...blocks.values()].map((list) => ({
    box: boundsOf(list),
    letterHeight: Math.max(3, quantile(list.map((c) => c.h), 0.6)),
    glyphs: list.length,
    list
  }))
}

/**
 * The thin end of something thicker than the filter (spikes of a shout bubble, hair, a dark panel):
 * next to it lie non-ink pixels of its own colour. A letter is surrounded by background only.
 */
function isTip(c: Comp, gray: Uint8Array, ink: Uint8Array, labels: Int32Array, ww: number, wh: number): boolean {
  const e = Math.max(2, Math.round(c.h * 0.35))
  const x0 = Math.max(0, c.x0 - e)
  const y0 = Math.max(0, c.y0 - e)
  const x1 = Math.min(ww, c.x1 + e)
  const y1 = Math.min(wh, c.y1 + e)
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 300)))
  let own = 0
  let ownCount = 0
  for (let y = c.y0; y < c.y1; y += step) {
    for (let x = c.x0; x < c.x1; x += step) {
      const p = y * ww + x
      if (labels[p] === c.id) (own += gray[p]), ownCount++
    }
  }
  if (!ownCount) return false
  own /= ownCount
  let around = 0
  let alike = 0
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = y * ww + x
      if (ink[p]) continue
      around++
      if (Math.abs(gray[p] - own) < 40) alike++
    }
  }
  return around > 0 && alike > around * 0.08
}

/** Most separate runs of the component met along a row through its middle. */
function strokesAcross(c: Comp, labels: Int32Array, ww: number): number {
  let best = 0
  for (const f of [0.3, 0.5, 0.7]) {
    const row = (c.y0 + Math.floor(c.h * f)) * ww
    let runs = 0
    let inside = false
    for (let x = c.x0; x < c.x1; x++) {
      const on = labels[row + x] === c.id
      if (on && !inside) runs++
      inside = on
    }
    best = Math.max(best, runs)
  }
  return best
}

/**
 * Letters of a line share a top or a baseline, along a straight line that may be tilted (panels drawn
 * in perspective); tips of spikes or hair along a curve do not.
 */
function isAligned(list: Comp[], h: number): boolean {
  if (list.length === 1) return true
  if (list.length >= 3) {
    const mid = quantile(list.map((c) => c.h), 0.5)
    if (list.filter((c) => Math.abs(c.h - mid) <= mid * 0.2).length < list.length * 0.6) return false
  }
  const cx = list.map((c) => (c.x0 + c.x1) / 2)
  const cy = list.map((c) => (c.y0 + c.y1) / 2)
  const mx = cx.reduce((s, v) => s + v, 0) / cx.length
  const my = cy.reduce((s, v) => s + v, 0) / cy.length
  let sxy = 0
  let sxx = 0
  cx.forEach((x, i) => ((sxy += (x - mx) * (cy[i] - my)), (sxx += (x - mx) ** 2)))
  const slope = list.length >= 3 && sxx > 0 ? sxy / sxx : 0
  if (Math.abs(slope) > 0.25) return false
  const tops = list.map((c, i) => c.y0 - slope * (cx[i] - mx))
  const bottoms = list.map((c, i) => c.y1 - slope * (cx[i] - mx))
  if (Math.max(...bottoms) - Math.min(...tops) > 1.8 * h) return false
  const top = quantile(tops, 0.5)
  const bottom = quantile(bottoms, 0.5)
  const tol = Math.max(2, h * 0.2)
  const aligned = list.filter((_, i) => Math.abs(tops[i] - top) <= tol || Math.abs(bottoms[i] - bottom) <= tol).length
  return list.length === 2 ? aligned === 2 : aligned >= list.length * 0.7
}

/**
 * Lettering is a run of glyphs of about the same height on one flat colour (bubble, caption box);
 * clusters picked out of artwork have few, uneven pieces on a busy background.
 */
function isTextBlock(
  block: TextRegion & { list: Comp[] },
  gray: Uint8Array,
  ink: Uint8Array,
  ww: number,
  wh: number
): boolean {
  const { list } = block
  const widest = Math.max(...list.map((c) => c.w / c.h))
  if (list.length < 3 && widest < 2.5) return false
  const heights = list.map((c) => c.h)
  if (list.length >= 3 && quantile(heights, 0.8) > 2.2 * quantile(heights, 0.2)) return false
  return flatBetween(block, gray, ink, ww, wh) || flatAround(block, gray, ww, wh)
}

/** Non-ink pixels in and just around the block mostly share one grey level (glow around letters is ink). */
function flatBetween(block: TextRegion, gray: Uint8Array, ink: Uint8Array, ww: number, wh: number): boolean {
  const { box, letterHeight } = block
  const pad = Math.round(letterHeight * 0.5)
  const x0 = Math.max(0, box[0] - pad)
  const y0 = Math.max(0, box[1] - pad)
  const x1 = Math.min(ww, box[2] + pad)
  const y1 = Math.min(wh, box[3] + pad)
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 800)))
  const around: number[] = []
  let total = 0
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      total++
      if (!ink[y * ww + x]) around.push(gray[y * ww + x])
    }
  }
  if (around.length < 16 || around.length < total * 0.45) return false
  const median = quantile(around, 0.5)
  let flat = 0
  for (const v of around) if (Math.abs(v - median) <= BLOCK_TOLERANCE) flat++
  return flat >= around.length * 0.7
}

/** The margin around the block, one strip per side, each judged on its own so gradients still pass. */
function flatAround(block: TextRegion, gray: Uint8Array, ww: number, wh: number): boolean {
  const { box, letterHeight } = block
  const near = Math.max(2, Math.round(letterHeight * 0.3))
  const far = Math.max(near + 2, Math.round(letterHeight * 0.9))
  const [bx0, by0, bx1, by1] = box
  const strips: Box[] = [
    [bx0 - far, by0 - far, bx1 + far, by0 - near],
    [bx0 - far, by1 + near, bx1 + far, by1 + far],
    [bx0 - far, by0, bx0 - near, by1],
    [bx1 + near, by0, bx1 + far, by1]
  ]
  let score = 0
  let sides = 0
  for (const [sx0, sy0, sx1, sy1] of strips) {
    const x0 = Math.max(0, sx0)
    const y0 = Math.max(0, sy0)
    const x1 = Math.min(ww, sx1)
    const y1 = Math.min(wh, sy1)
    if (x1 - x0 < 2 || y1 - y0 < 2) continue
    const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 200)))
    const values: number[] = []
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) values.push(gray[y * ww + x])
    const median = quantile(values, 0.5)
    let flat = 0
    for (const v of values) if (Math.abs(v - median) <= BLOCK_TOLERANCE) flat++
    score += flat / values.length
    sides++
  }
  return sides > 0 && score / sides >= 0.75
}

/**
 * The tips of a shout bubble's spikes (and the white gaps between them) line up like letters, but one
 * side of them is a solid mass of their own colour: the band they grow out of, or the bubble's inside.
 * Lettering has the background on every side.
 */
function besideOwnColour(block: TextRegion & { list: Comp[] }, gray: Uint8Array, labels: Int32Array, ww: number, wh: number): boolean {
  const values: number[] = []
  for (const c of block.list) {
    const step = Math.max(1, Math.round(Math.sqrt(c.count / 50)))
    for (let y = c.y0; y < c.y1; y += step) {
      for (let x = c.x0; x < c.x1; x += step) if (labels[y * ww + x] === c.id) values.push(gray[y * ww + x])
    }
  }
  if (!values.length) return false
  const own = quantile(values, 0.5)
  const { box, letterHeight } = block
  const near = Math.max(2, Math.round(letterHeight * 0.3))
  const far = Math.max(near + 2, Math.round(letterHeight * 0.9))
  const [bx0, by0, bx1, by1] = box
  const strips: Box[] = [
    [bx0, by0 - far, bx1, by0 - near],
    [bx0, by1 + near, bx1, by1 + far],
    [bx0 - far, by0, bx0 - near, by1],
    [bx1 + near, by0, bx1 + far, by1]
  ]
  for (const [sx0, sy0, sx1, sy1] of strips) {
    const x0 = Math.max(0, sx0)
    const y0 = Math.max(0, sy0)
    const x1 = Math.min(ww, sx1)
    const y1 = Math.min(wh, sy1)
    if (x1 - x0 < 2 || y1 - y0 < 2) continue
    const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 200)))
    const strip: number[] = []
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) strip.push(gray[y * ww + x])
    if (Math.abs(quantile(strip, 0.5) - own) < 35) return true
  }
  return false
}

/** Outlined lettering shows up in both passes (the outline dark, the fill light): one block. */
function mergeRegions(regions: TextRegion[]): TextRegion[] {
  const out: TextRegion[] = []
  for (const region of [...regions].sort((a, b) => b.glyphs - a.glyphs)) {
    const twin = out.find((o) => overlapArea(o.box, region.box) > 0.3 * Math.min(area(o.box), area(region.box)))
    if (!twin) {
      out.push({ ...region })
      continue
    }
    twin.box = [
      Math.min(twin.box[0], region.box[0]),
      Math.min(twin.box[1], region.box[1]),
      Math.max(twin.box[2], region.box[2]),
      Math.max(twin.box[3], region.box[3])
    ]
  }
  return out
}

/**
 * Lines of one bubble that the line grouping kept apart (one set bigger, a wider gap) become one region:
 * they sit right above each other and the bubble's background connects them without crossing a border.
 * Otherwise the model tends to name only one part, and the rest stays in the original language.
 */
function joinBubbles(regions: TextRegion[], gray: Uint8Array, W: number, H: number): TextRegion[] {
  const parent = regions.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]
      const b = regions[j]
      const lo = Math.min(a.letterHeight, b.letterHeight)
      const hi = Math.max(a.letterHeight, b.letterHeight)
      if (hi > 1.8 * lo) continue
      const gapY = Math.max(0, b.box[1] - a.box[3], a.box[1] - b.box[3])
      const overlapX = Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0])
      const minW = Math.min(a.box[2] - a.box[0], b.box[2] - b.box[0])
      if (gapY > 2.2 * hi || overlapX < 0.5 * minW) continue
      if (sameBackground(a.box, b.box, hi, gray, W, H)) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, TextRegion[]>()
  regions.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]))
  return [...groups.values()].map((list) => ({
    box: list.map((r) => r.box).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]),
    letterHeight: Math.max(...list.map((r) => r.letterHeight)),
    glyphs: list.reduce((n, r) => n + r.glyphs, 0)
  }))
}

/** Whether background of the colour around `a` leads, around the letters, to the area around `b`. */
function sameBackground(a: Box, b: Box, letterHeight: number, gray: Uint8Array, W: number, H: number): boolean {
  const pad = Math.max(2, Math.round(letterHeight * 0.3))
  const x0 = Math.max(0, Math.min(a[0], b[0]) - 2 * pad)
  const y0 = Math.max(0, Math.min(a[1], b[1]) - 2 * pad)
  const x1 = Math.min(W, Math.max(a[2], b[2]) + 2 * pad)
  const y1 = Math.min(H, Math.max(a[3], b[3]) + 2 * pad)
  const ww = x1 - x0
  const inRing = (box: Box, x: number, y: number) =>
    x >= box[0] - pad && x < box[2] + pad && y >= box[1] - pad && y < box[3] + pad && !(x >= box[0] && x < box[2] && y >= box[1] && y < box[3])
  const ringA: number[] = []
  const ringB: number[] = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (inRing(a, x, y)) ringA.push(y * W + x)
      if (inRing(b, x, y)) ringB.push(y * W + x)
    }
  }
  if (!ringA.length || !ringB.length) return false
  const bg = quantile(ringA.map((p) => gray[p]), 0.5)
  if (Math.abs(quantile(ringB.map((p) => gray[p]), 0.5) - bg) > BLOCK_TOLERANCE) return false
  const target = new Set(ringB)
  const seen = new Uint8Array(ww * (y1 - y0))
  const queue: number[] = []
  for (const p of ringA) {
    if (Math.abs(gray[p] - bg) > BLOCK_TOLERANCE) continue
    if (target.has(p)) return true
    seen[(Math.floor(p / W) - y0) * ww + (p % W) - x0] = 1
    queue.push(p)
  }
  while (queue.length) {
    const p = queue.pop()!
    const x = p % W
    const y = (p - x) / W
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1]
    ]) {
      if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue
      const s = (ny - y0) * ww + nx - x0
      const q = ny * W + nx
      if (seen[s] || Math.abs(gray[q] - bg) > BLOCK_TOLERANCE) continue
      if (target.has(q)) return true
      seen[s] = 1
      queue.push(q)
    }
  }
  return false
}

/** A copy of the image with each region outlined and tagged with its number, for the model to refer to. */
export function drawMarks(source: HTMLCanvasElement, marks: { id: number; box: Box }[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(source, 0, 0)
  const W = canvas.width
  const H = canvas.height
  const line = Math.max(2, Math.round(W / 400))
  const fontSize = Math.round(Math.min(24, Math.max(13, W / 50)))
  ctx.font = `bold ${fontSize}px Arial, sans-serif`
  ctx.textBaseline = 'top'
  for (const { id, box } of marks) {
    // Outside the strokes, so the box never hides part of a letter.
    const pad = line + 3
    const x0 = Math.max(0, box[0] - pad)
    const y0 = Math.max(0, box[1] - pad)
    const x1 = Math.min(W, box[2] + pad)
    const y1 = Math.min(H, box[3] + pad)
    ctx.strokeStyle = MARK_COLOR
    ctx.lineWidth = line
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
    const label = String(id)
    const tw = ctx.measureText(label).width + 8
    const th = fontSize + 4
    const tx = Math.min(x0, W - tw)
    const ty = y0 - th >= 0 ? y0 - th : Math.min(y1, H - th)
    ctx.fillStyle = MARK_COLOR
    ctx.fillRect(tx, ty, tw, th)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, tx + 4, ty + 2)
  }
  return canvas
}

const KEY_WIDTH = 1024
const KEY_MAX_HEIGHT = 1536
/** Letter height the regions are enlarged (or reduced) to on the key. */
const KEY_LETTER = 28

/**
 * Every region cut out of its image, scaled to a readable letter size and tagged with its number,
 * packed into as few images as needed: the model reads each box there and sees the page for context.
 */
export function drawKey(regions: { id: number; source: HTMLCanvasElement; box: Box; letterHeight: number }[]): HTMLCanvasElement[] {
  const gap = 10
  const fontSize = 20
  const tagW = 44
  const tiles = regions.map((r) => {
    const pad = Math.round(r.letterHeight * 0.4)
    const x0 = Math.max(0, r.box[0] - pad)
    const y0 = Math.max(0, r.box[1] - pad)
    const x1 = Math.min(r.source.width, r.box[2] + pad)
    const y1 = Math.min(r.source.height, r.box[3] + pad)
    const s = Math.min(
      Math.max(0.6, Math.min(3, KEY_LETTER / Math.max(1, r.letterHeight))),
      (KEY_WIDTH - tagW - 2 * gap) / (x1 - x0),
      (KEY_MAX_HEIGHT - 2 * gap) / (y1 - y0)
    )
    return { ...r, src: [x0, y0, x1, y1] as Box, w: Math.round((x1 - x0) * s), h: Math.round((y1 - y0) * s) }
  })

  const sheets: { tiles: (typeof tiles[number] & { x: number; y: number })[]; height: number }[] = []
  let sheet: (typeof sheets)[number] = { tiles: [], height: gap }
  let x = gap
  let rowTop = gap
  let rowH = 0
  for (const tile of tiles) {
    const width = tagW + tile.w + gap
    if (x + width > KEY_WIDTH) (x = gap), (rowTop += rowH + gap), (rowH = 0)
    if (rowTop + tile.h + gap > KEY_MAX_HEIGHT && sheet.tiles.length) {
      sheets.push(sheet)
      sheet = { tiles: [], height: gap }
      x = gap
      rowTop = gap
      rowH = 0
    }
    sheet.tiles.push({ ...tile, x, y: rowTop })
    sheet.height = Math.max(sheet.height, rowTop + tile.h + gap)
    x += width
    rowH = Math.max(rowH, tile.h)
  }
  if (sheet.tiles.length) sheets.push(sheet)

  return sheets.map(({ tiles: placed, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = KEY_WIDTH
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#555555'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.font = `bold ${fontSize}px Arial, sans-serif`
    ctx.textBaseline = 'middle'
    for (const t of placed) {
      ctx.fillStyle = MARK_COLOR
      ctx.fillRect(t.x, t.y, tagW - 4, Math.min(t.h, fontSize + 12))
      ctx.fillStyle = '#ffffff'
      ctx.fillText(String(t.id), t.x + 4, t.y + Math.min(t.h, fontSize + 12) / 2)
      const [x0, y0, x1, y1] = t.src
      ctx.drawImage(t.source, x0, y0, x1 - x0, y1 - y0, t.x + tagW, t.y, t.w, t.h)
    }
    return canvas
  })
}

function boundsOf(list: Comp[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const c of list) {
    x0 = Math.min(x0, c.x0)
    y0 = Math.min(y0, c.y0)
    x1 = Math.max(x1, c.x1)
    y1 = Math.max(y1, c.y1)
  }
  return [x0, y0, x1, y1]
}

function gapX(a: Comp, b: Comp): number {
  return Math.max(0, b.x0 - a.x1, a.x0 - b.x1)
}

function area(b: Box): number {
  return Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
}

function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
}
