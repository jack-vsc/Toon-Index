import type { Box, FontRole, TextBlock } from '../../../shared/types'
import { FONTS } from './fonts'
import { components, dilate, erode, isGlyph, odd, quantile, type Comp } from './glyphs'
import { normalizeText, similarText } from './text'

const MIN_FONT = 8
/** Line pitch / cap height when the original has a single line to measure it from. */
const LINE_PITCH = 1.55
/** Local contrast of ink pixels: strong ones anchor a glyph, weak ones (anti-aliased edges) extend it. */
const INK_STRONG = 45
const INK_WEAK = 22
/** Max per-channel distance for a pixel to count as bubble background when measuring the bubble. */
const BG_TOLERANCE = 42

interface Glyphs {
  /** Search window in canvas pixels; `mask` is in window coordinates. */
  win: Box
  ww: number
  wh: number
  /** 1 = pixel of an original glyph. */
  mask: Uint8Array
  /** 1 = pixel of any thin stroke, dark or light (not flat background). */
  ink: Uint8Array
  /** Bounding box of the glyphs in canvas pixels, or null when none were found. */
  bbox: Box | null
  /** Typical letter height in px. */
  letterHeight: number
  /** How well the glyphs match the block; decides between two blocks claiming the same lettering. */
  score: number
  /** Measured look of the original lettering, or null when no glyphs were found. */
  look: Look | null
}

type RGB = [number, number, number]

interface Look {
  capHeight: number
  /** Distance between the tops of consecutive lines, 0 for a single line. */
  pitch: number
  fill: RGB
  outline: RGB | null
  /** Outline thickness / cap height. */
  outlineRatio: number
  /** Stroke thickness / cap height. */
  weight: number
  /** Ink mass / (cap height Ã— total line width): how dark the text lines are. */
  ink: number
  /** Total line width / cap height. */
  span: number
  /** Average advance per character, spaces included / cap height. */
  advance: number
  /** Width / height of the original block of text. */
  aspect: number
  /** Horizontal shift of the strokes per pixel of height (italic lettering leans right: > 0). */
  slant: number
}

/** What the overlay measured and chose for one block (evaluation runs). */
export interface OverlayInfo {
  drawn: boolean
  /** Letter height of the original glyphs found, 0 when none were. */
  letterHeight: number
  capHeight?: number
  fontSize?: number
  family?: string
}

/** Signage and narration placed only on the artwork are listed below the panel instead of over the art. */
function isFootnote(block: TextBlock): boolean {
  return block.kind === 'signage' || (block.kind === 'narration' && !block.inkBoxes)
}

/** Erases the original text of every block, then writes the translations on top. Load fonts first (`ensureFonts`). */
export function drawOverlay(canvas: HTMLCanvasElement, blocks: TextBlock[]): OverlayInfo[] {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const W = canvas.width
  const H = canvas.height
  // Locate all glyphs on the untouched page first, then erase, then write: no step sees another's output.
  const glyphs = blocks.map((block) => findGlyphs(ctx, block, W, H))
  const kept = new Set<number>()
  blocks.forEach((block, i) => {
    // Interjections and names that read the same in both languages keep their original lettering.
    const text = normalizeText(block.translation)
    if (!text || text === normalizeText(block.original)) kept.add(i)
    // Placed by the model's own box and no lettering there: writing it would cover the art, not the text.
    if (!block.inkBoxes && !glyphs[i].bbox && !isFootnote(block)) kept.add(i)
  })
  const skipDraw = duplicates(blocks, glyphs, kept)
  for (const i of kept) skipDraw.add(i)
  blocks.forEach((block, i) => {
    if (!skipDraw.has(i) && isFootnote(block)) skipDraw.add(i)
  })
  const skipErase = new Set(kept)
  for (let i = 0; i < blocks.length; i++) {
    if (skipDraw.has(i) && !isFootnote(blocks[i])) skipErase.add(i)
  }
  glyphs.forEach((g, i) => skipErase.has(i) || erase(ctx, g))

  const footnotes: string[] = []
  blocks.forEach((block, i) => {
    if (!isFootnote(block) || !skipDraw.has(i)) return
    if (kept.has(i)) return
    const t = block.translation.trim()
    if (t) footnotes.push(t)
  })
  if (footnotes.length) appendFootnotes(canvas, footnotes)

  return blocks.map((block, i) => ({
    drawn: !skipDraw.has(i),
    letterHeight: glyphs[i].letterHeight,
    ...(skipDraw.has(i) ? {} : typeset(ctx, block, glyphs[i], W, H))
  }))
}

/** Adds a band below the page with *adendo lines (signage and similar). */
function appendFootnotes(canvas: HTMLCanvasElement, notes: string[]): void {
  const ctx = canvas.getContext('2d')!
  const pad = Math.round(canvas.width * 0.02)
  const fontSize = Math.max(13, Math.round(canvas.width / 52))
  const lineGap = Math.round(fontSize * 0.35)
  ctx.font = `italic ${fontSize}px ${FONTS.sans.family}`
  const lines = notes.map((t) => `*${t}`)
  const lineH = fontSize + lineGap
  const band = pad * 2 + lines.length * lineH
  const prev = ctx.getImageData(0, 0, canvas.width, canvas.height)
  canvas.height += band
  ctx.putImageData(prev, 0, 0)
  ctx.fillStyle = '#f0f0f0'
  ctx.fillRect(0, canvas.height - band, canvas.width, band)
  ctx.strokeStyle = '#bdbdbd'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, canvas.height - band)
  ctx.lineTo(canvas.width, canvas.height - band)
  ctx.stroke()
  ctx.fillStyle = '#212121'
  ctx.textBaseline = 'top'
  let y = canvas.height - band + pad
  const maxW = canvas.width - 2 * pad
  for (const line of lines) {
    y += wrapFootnote(ctx, line, pad, y, maxW, lineH)
  }
}

function wrapFootnote(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number): number {
  let line = ''
  let used = 0
  for (const char of text) {
    const next = line + char
    if (line && ctx.measureText(next).width > maxW) {
      ctx.fillText(line, x, y + used)
      used += lineH
      line = char
    } else line = next
  }
  if (line) ctx.fillText(line, x, y + used)
  return used + lineH
}

/**
 * Overlapping slices can report one bubble twice, sometimes with boxes far apart. Blocks whose glyphs
 * resolve to the same lettering are one block; a copy whose lettering was not found, or matches far
 * worse (artwork picked up where the copy was misplaced), is dropped too.
 */
function duplicates(blocks: TextBlock[], glyphs: Glyphs[], ignored: Set<number>): Set<number> {
  const drop = new Set<number>()
  const area = (b: Box) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
  for (let i = 0; i < blocks.length; i++) {
    if (ignored.has(i)) continue
    for (let j = i + 1; j < blocks.length; j++) {
      if (ignored.has(j)) continue
      const a = glyphs[i]
      const b = glyphs[j]
      const loser = a.score >= b.score ? j : i
      if (a.bbox && b.bbox && overlapArea(a.bbox, b.bbox) > 0.5 * Math.min(area(a.bbox), area(b.bbox))) {
        drop.add(loser)
      } else if (similarText(blocks[i].original, blocks[j].original)) {
        const ti = blocks[i].textBox
        const tj = blocks[j].textBox
        const close = Math.abs(ti[1] - tj[1]) < (ti[2] - ti[0] + tj[2] - tj[0]) * 1.5
        if (!(a.bbox || b.bbox)) continue
        if (!a.bbox || !b.bbox) {
          if (!close) continue
          drop.add(a.bbox ? j : i)
          continue
        }
        // One text is lettered at one size; a copy whose "letters" are far bigger or smaller is artwork.
        const sizes = [a.letterHeight, b.letterHeight].sort((x, y) => x - y)
        const ratio = Math.min(a.score, b.score) / Math.max(a.score, b.score, 1e-6)
        if (ratio < 0.5 || (ratio < 0.7 && sizes[1] > 2 * sizes[0])) drop.add(loser)
      }
    }
  }
  return drop
}

// ---------------------------------------------------------------------------------------------------
// Glyph detection
// ---------------------------------------------------------------------------------------------------

interface Cluster {
  comps: Comp[]
  bbox: Box
  letterHeight: number
  score: number
  /** How well the number of glyphs matches the length of the original text (1 = exactly). */
  textness: number
  labels: Int32Array
  ink: Uint8Array
  /** Strong-ink components that failed the glyph tests. */
  rejected: Comp[]
  /** Dark lettering on a lighter background. */
  dark: boolean
}

/**
 * The model's boxes are often off by a line or more, so the lettering is located from the pixels.
 * A morphological black-hat (dark text) or top-hat (light text) isolates thin strokes on any smooth
 * background; strokes whose surroundings are not flat (artwork) are dropped; the rest are grouped into
 * clusters, and the cluster that best matches the model's box and the length of the original text wins.
 */
export function findGlyphs(ctx: CanvasRenderingContext2D, block: TextBlock, W: number, H: number): Glyphs {
  const tb = block.textBox
  const tbW = tb[2] - tb[0]
  const tbH = tb[3] - tb[1]
  const margin = Math.max(W * 0.05, Math.min(tbH * 1.5, W * 0.15))
  const win = roundBox(clampBox(expand(union(tb, block.areaBox), margin), W, H))
  const ww = win[2] - win[0]
  const wh = win[3] - win[1]
  const blank = new Uint8Array(Math.max(0, ww * wh))
  const empty: Glyphs = { win, ww, wh, mask: blank, ink: blank, bbox: null, letterHeight: 0, score: 0, look: null }
  if (ww < 8 || wh < 8) return empty

  const data = ctx.getImageData(win[0], win[1], ww, wh).data
  const gray = new Uint8Array(ww * wh)
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8

  const toLocal = (b: Box): Box => [b[0] - win[0], b[1] - win[1], b[2] - win[0], b[3] - win[1]]
  const near = toLocal(expandXY(tb, tbW * 0.15, tbH * 0.3))
  const area = toLocal(block.areaBox)
  const expected = Math.max(1, block.original.replace(/\s+/g, '').length)

  // The filter must be wider than the strokes, which scale with the lettering.
  const letter = estimateLetter(block)
  const k = odd(clamp(Math.round(Math.max(W / 50, letter * 0.8)), 11, 41))
  const closing = erode(dilate(gray, ww, wh, k), ww, wh, k)
  const opening = dilate(erode(gray, ww, wh, k), ww, wh, k)
  const contrasts = [true, false].map((dark) => {
    const contrast = new Uint8Array(ww * wh)
    for (let p = 0; p < contrast.length; p++) {
      const c = dark ? closing[p] - gray[p] : gray[p] - opening[p]
      contrast[p] = c > 0 ? c : 0
    }
    return contrast
  })
  const strokes = new Uint8Array(ww * wh)
  for (let p = 0; p < strokes.length; p++) strokes[p] = contrasts[0][p] > INK_WEAK || contrasts[1][p] > INK_WEAK ? 1 : 0
  empty.ink = strokes
  const attempt = (strongInk: number, best: Cluster | null): Cluster | null => {
    for (const contrast of contrasts) {
      const cluster = bestCluster(contrast, gray, ww, wh, near, area, expected, W, letter, strongInk, contrast === contrasts[0])
      // The counters and gaps of dark lettering look like light lettering, but they share the
      // background's grey level.
      if (cluster && inkContrast(cluster, gray, ww, wh) < 50) continue
      if (cluster && (!best || cluster.score > best.score)) best = cluster
    }
    return best
  }
  let best = attempt(INK_STRONG, null)
  // Hollow or outlined letters set tightly weld into one blob; a stricter threshold separates them at
  // their faint joins.
  if (!best || best.textness < 0.35) best = attempt(INK_STRONG * 2, best)
  if (best) {
    // Lettering covers a fraction of its box (bold condensed type the most); a solid blob is artwork.
    const strongInk = best.comps.reduce((n, c) => n + c.count, 0)
    const bb = best.bbox
    const size = (bb[2] - bb[0]) * (bb[3] - bb[1])
    // A poor match away from where the model saw the text is artwork (windows, a pattern), not the text.
    if (strongInk > size * 0.75 || (best.score < 3 && overlapArea(bb, near) < 0.3 * size)) best = null
  }
  const inkBoxes = (block.inkBoxes ?? []).map((b) => roundBox(clampBox(toLocal(b), ww, wh)))
  // Lettering found elsewhere than in the detected boxes, or at another size than the detector measured
  // there, is other text, specks of glow or artwork.
  if (best && inkBoxes.length && !inkBoxes.some((b) => overlapArea(b, best!.bbox) > 0)) best = null
  const lh = block.letterHeight
  if (best && lh && (best.letterHeight < 0.6 * lh || best.letterHeight > 1.7 * lh)) best = null
  if (!best) return inkBoxes.length ? detectedOnly(empty, block, inkBoxes, contrasts, gray) : empty
  if (inkBoxes.length) {
    // Pieces out of the detected lettering are bubble spikes, the gaps between them or screentone dots.
    const zones = inkBoxes.map((b) => expand(b, best!.letterHeight * 0.5))
    const kept = best.comps.filter((c) => {
      const x = (c.x0 + c.x1) / 2
      const y = (c.y0 + c.y1) / 2
      return zones.some((z) => x >= z[0] && x <= z[2] && y >= z[1] && y <= z[3])
    })
    if (!kept.length) return detectedOnly(empty, block, inkBoxes, contrasts, gray)
    if (kept.length < best.comps.length) {
      best.comps = kept
      best.bbox = boundsOf(kept)
    }
  }

  const mask = new Uint8Array(ww * wh)
  addInkBoxes(mask, ww, wh, inkBoxes, contrasts, gray, lh ?? best.letterHeight)
  if (inkBoxes.length) best.bbox = inkBoxes.reduce(union, best.bbox)

  // Ink right around the chosen glyphs goes too: letters touching artwork (a speed line crossing the
  // text) merge into a big component that is not letter-like.
  const ids = new Set(best.comps.map((c) => c.id))
  for (let p = 0; p < mask.length; p++) if (ids.has(best.labels[p])) mask[p] = 1
  const pad = Math.round(best.letterHeight * 0.25)
  for (const c of best.comps) {
    for (let y = Math.max(0, c.y0 - pad); y < Math.min(wh, c.y1 + pad); y++) {
      for (let x = Math.max(0, c.x0 - pad); x < Math.min(ww, c.x1 + pad); x++) {
        if (best.ink[y * ww + x]) mask[y * ww + x] = 1
      }
    }
  }

  // Letters welded to a stroke that crosses the text line (speed lines) are rejected as glyphs; take
  // the part of such strokes that lies in a text line, right next to it.
  const h0 = best.letterHeight
  for (const band of textBands(best.comps, h0)) {
    for (const r of best.rejected) {
      if (r.y1 <= band.y0 || r.y0 >= band.y1) continue
      const y0 = Math.max(band.y0, r.y0)
      const y1 = Math.min(band.y1, r.y1)
      const used = new Uint8Array(r.w)
      for (let y = y0; y < y1; y++) {
        for (let x = r.x0; x < r.x1; x++) if (best.labels[y * ww + x] === r.id) used[x - r.x0] = 1
      }
      // Runs of columns in the band; narrow ones (the sides of an outline, a crossing line) are not
      // lettering, nor are sparse ones (a curved outline sweeping through the band) or distant ones.
      for (const [a, b] of runs(used, Math.round(h0 * 0.5))) {
        // A stroke beside the text (a panel edge, the bubble's border) is not part of it; one that
        // crosses it is cut off just past the letters.
        const crossing = Math.min(r.x0 + b, band.x1) - Math.max(r.x0 + a, band.x0)
        const rx0 = Math.max(r.x0 + a, band.x0 - Math.round(h0 * 0.5))
        const rx1 = Math.min(r.x0 + b, band.x1 + Math.round(h0 * 0.5))
        if (crossing < h0 * 0.5 || rx1 - rx0 < h0 * 1.5) continue
        let filled = 0
        for (let y = y0; y < y1; y++) {
          for (let x = rx0; x < rx1; x++) if (best.labels[y * ww + x] === r.id) filled++
        }
        if (filled < (rx1 - rx0) * (y1 - y0) * 0.2) continue
        for (let y = y0; y < y1; y++) {
          for (let x = rx0; x < rx1; x++) if (best.labels[y * ww + x] === r.id) mask[y * ww + x] = 1
        }
        best.bbox = [Math.min(best.bbox[0], rx0), best.bbox[1], Math.max(best.bbox[2], rx1), best.bbox[3]]
      }
    }
  }

  const b = best.bbox
  return {
    win,
    ww,
    wh,
    mask,
    ink: strokes,
    bbox: [b[0] + win[0], b[1] + win[1], b[2] + win[0], b[3] + win[1]],
    letterHeight: best.letterHeight,
    score: best.score,
    look: measureLook(data, ww, wh, best, block.original)
  }
}

/**
 * Marks the glyphs inside the detected boxes, with the faint ink right around them (anti-aliased
 * edges). The polarity with more letter-sized strokes is the lettering; strokes of the other polarity
 * count only where they touch it (an outline, a glow). Pieces reaching out of a box must be letters on
 * a flat background: bubble spikes and artwork stay.
 */
function addInkBoxes(mask: Uint8Array, ww: number, wh: number, boxes: Box[], contrasts: Uint8Array[], gray: Uint8Array, letterHeight: number): void {
  if (!boxes.length) return
  const pad = Math.round(letterHeight * 0.25)
  const zones = boxes.map((b) => expand(b, pad))
  // Letters cover a fraction of their box, so its median is the background. Gaps between dark letters
  // look like light strokes to the top-hat, but they have the background's colour.
  const samples: number[] = []
  for (const b of boxes) {
    const step = Math.max(1, Math.round(Math.sqrt(((b[2] - b[0]) * (b[3] - b[1])) / 2000)))
    for (let y = b[1]; y < b[3]; y += step) for (let x = b[0]; x < b[2]; x += step) samples.push(gray[y * ww + x])
  }
  const bg = quantile(samples, 0.5)
  const found = contrasts.map((contrast) => {
    const ink = new Uint8Array(ww * wh)
    const strong = new Uint8Array(ww * wh)
    for (let p = 0; p < ink.length; p++) {
      ink[p] = contrast[p] > INK_WEAK ? 1 : 0
      strong[p] = contrast[p] > INK_STRONG ? 1 : 0
    }
    const { labels, comps } = components(strong, ww, wh)
    const glyphs = comps.filter((c) => {
      if (c.count < 3 || c.h > letterHeight * 2) return false
      if (Math.abs(medianGray(c, labels, gray, ww) - bg) < 40) return false
      const cb: Box = [c.x0, c.y0, c.x1, c.y1]
      if (boxes.some((b) => c.x0 >= b[0] && c.y0 >= b[1] && c.x1 <= b[2] && c.y1 <= b[3])) return true
      return zones.some((z) => overlapArea(cb, z) >= 0.7 * Math.max(1, c.w * c.h)) && isGlyph(c, gray, ink, labels, ww, wh)
    })
    const own = new Uint8Array(ww * wh)
    for (const c of glyphs) {
      for (let y = Math.max(0, c.y0 - pad); y < Math.min(wh, c.y1 + pad); y++) {
        for (let x = Math.max(0, c.x0 - pad); x < Math.min(ww, c.x1 + pad); x++) {
          const p = y * ww + x
          if (labels[p] === c.id || ink[p]) own[p] = 1
        }
      }
    }
    return { glyphs, labels, own, mass: glyphs.reduce((n, c) => n + c.count, 0) }
  })
  const main = found[0].mass >= found[1].mass ? found[0] : found[1]
  const other = main === found[0] ? found[1] : found[0]
  const touch = dilate(main.own, ww, wh, 3)
  for (let p = 0; p < mask.length; p++) if (main.own[p]) mask[p] = 1
  for (const c of other.glyphs) {
    let touching = false
    for (let y = c.y0; y < c.y1 && !touching; y++) {
      for (let x = c.x0; x < c.x1; x++) if (other.labels[y * ww + x] === c.id && touch[y * ww + x]) (touching = true), (x = c.x1)
    }
    if (!touching) continue
    for (let y = Math.max(0, c.y0 - pad); y < Math.min(wh, c.y1 + pad); y++) {
      for (let x = Math.max(0, c.x0 - pad); x < Math.min(ww, c.x1 + pad); x++) if (other.own[y * ww + x]) mask[y * ww + x] = 1
    }
  }
}

function medianGray(c: Comp, labels: Int32Array, gray: Uint8Array, ww: number): number {
  const values: number[] = []
  const step = Math.max(1, Math.round(Math.sqrt(c.count / 100)))
  for (let y = c.y0; y < c.y1; y += step) {
    for (let x = c.x0; x < c.x1; x += step) if (labels[y * ww + x] === c.id) values.push(gray[y * ww + x])
  }
  return quantile(values, 0.5)
}

/**
 * The lettering could not be measured, but the detector boxed it: the glyphs in those boxes are
 * erased, and the translation goes where they are.
 */
function detectedOnly(empty: Glyphs, block: TextBlock, boxes: Box[], contrasts: Uint8Array[], gray: Uint8Array): Glyphs {
  const { win, ww, wh } = empty
  const letterHeight = Math.max(3, block.letterHeight ?? Math.min(estimateLetter(block), ...boxes.map((b) => b[3] - b[1])))
  const mask = new Uint8Array(ww * wh)
  addInkBoxes(mask, ww, wh, boxes, contrasts, gray, letterHeight)
  const b = boxes.reduce(union)
  return { ...empty, mask, bbox: [b[0] + win[0], b[1] + win[1], b[2] + win[0], b[3] + win[1]], letterHeight }
}

/** Grey-level difference between a cluster's strokes and the background around the whole cluster. */
function inkContrast(cluster: Cluster, gray: Uint8Array, ww: number, wh: number): number {
  const ids = new Set(cluster.comps.map((c) => c.id))
  const own = new Uint8Array(ww * wh)
  for (let p = 0; p < own.length; p++) if (ids.has(cluster.labels[p])) own[p] = 1
  const near = dilate(own, ww, wh, odd(Math.round(cluster.letterHeight * 0.3)))
  const pad = Math.round(cluster.letterHeight)
  const [x0, y0, x1, y1] = cluster.bbox
  const ink: number[] = []
  const around: number[] = []
  for (let y = Math.max(0, y0 - pad); y < Math.min(wh, y1 + pad); y++) {
    for (let x = Math.max(0, x0 - pad); x < Math.min(ww, x1 + pad); x++) {
      const p = y * ww + x
      if (own[p]) ink.push(gray[p])
      else if (!near[p]) around.push(gray[p])
    }
  }
  if (!ink.length || !around.length) return 0
  return Math.abs(quantile(ink, 0.5) - quantile(around, 0.5))
}

/** Colours, weight, proportions and spacing of the original lettering, read from its pixels. */
function measureLook(data: Uint8ClampedArray, ww: number, wh: number, best: Cluster, original: string): Look {
  const ids = new Set(best.comps.map((c) => c.id))
  const own = new Uint8Array(ww * wh)
  for (let p = 0; p < own.length; p++) if (ids.has(best.labels[p])) own[p] = 1
  const letters = best.comps.filter((c) => c.h >= best.letterHeight * 0.5)
  const capHeight = Math.max(3, quantile(letters.map((c) => c.h), 0.8))
  const bands = textBands(best.comps, best.letterHeight)
  const [x0, y0, x1, y1] = best.bbox

  // Stroke pixels: the interior ones carry the fill colour (edges are blended with the background).
  const inner: RGB[] = []
  const all: RGB[] = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * ww + x
      if (!own[p]) continue
      const edge = x === 0 || y === 0 || x === ww - 1 || y === wh - 1 || !own[p - 1] || !own[p + 1] || !own[p - ww] || !own[p + ww]
      const rgb: RGB = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]
      if (!edge) inner.push(rgb)
      all.push(rgb)
    }
  }
  const fill = medianRgb(inner.length >= 20 ? inner : all)

  // A ring just outside the strokes that differs from both the fill and the background is an outline.
  const r = Math.max(2, Math.round(capHeight * 0.2))
  const near = dilate(own, ww, wh, 3)
  const ringed = dilate(own, ww, wh, 2 * r + 1)
  const wide = dilate(own, ww, wh, 2 * Math.round(capHeight * 0.6) + 1)
  const ring: RGB[] = []
  const bg: RGB[] = []
  const pad = Math.round(capHeight)
  for (let y = Math.max(0, y0 - pad); y < Math.min(wh, y1 + pad); y++) {
    for (let x = Math.max(0, x0 - pad); x < Math.min(ww, x1 + pad); x++) {
      const p = y * ww + x
      const rgb: RGB = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]
      if (ringed[p] && !near[p]) ring.push(rgb)
      else if (!wide[p]) bg.push(rgb)
    }
  }
  const ringColor = medianRgb(ring)
  const bgColor = medianRgb(bg.length ? bg : ring)
  const outline = ring.length && colorDistance(ringColor, bgColor) > 60 && colorDistance(ringColor, fill) > 60 ? ringColor : null
  const outlineRatio = outline ? (r * ring.filter((c) => colorDistance(c, outline) < 50).length) / ring.length / capHeight : 0

  // Stroke thickness where the strokes are halfway between fill and background, and ink mass: each
  // pixel around the strokes counts by how close it is to the fill. Blurred or soft lettering looks as
  // heavy as its mass, not as its sharp outline.
  const fillGray = luminance(fill)
  const bgGray = luminance(bgColor)
  const half = (fillGray + bgGray) / 2
  const dark = fillGray < bgGray
  const halo = dilate(own, ww, wh, odd(Math.max(3, Math.round(capHeight * 0.3))))
  const solid = new Uint8Array(ww * wh)
  let mass = 0
  for (let y = Math.max(0, y0 - r); y < Math.min(wh, y1 + r); y++) {
    for (let x = Math.max(0, x0 - r); x < Math.min(ww, x1 + r); x++) {
      const p = y * ww + x
      if (!halo[p]) continue
      const g = luminance([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]])
      if (near[p] && (dark ? g < half : g > half)) solid[p] = 1
      const f = (bgGray - g) / (bgGray - fillGray || 1)
      if (f > 0.08) mass += Math.min(1, f)
    }
  }
  const weight = strokeWeight(solid, ww, [x0, y0, x1, y1], capHeight)

  const chars = Math.max(1, original.replace(/\s+/g, ' ').trim().length)
  const lineWidth = bands.reduce((n, b) => n + b.x1 - b.x0, 0)
  return {
    capHeight,
    pitch: bands.length > 1 ? (bands[bands.length - 1].y0 - bands[0].y0) / (bands.length - 1) : 0,
    fill,
    outline,
    outlineRatio,
    weight,
    ink: mass / (capHeight * Math.max(1, lineWidth)),
    span: lineWidth / capHeight,
    advance: lineWidth / chars / capHeight,
    aspect: (x1 - x0) / Math.max(1, y1 - y0),
    slant: measureSlant(own, ww, bands, best.bbox)
  }
}

/** Average stroke thickness (twice the area over the perimeter) / cap height. */
function strokeWeight(mask: Uint8Array, ww: number, box: Box, capHeight: number): number {
  let area = 0
  let perimeter = 0
  for (let y = Math.max(1, box[1]); y < box[3] - 1; y++) {
    for (let x = Math.max(1, box[0]); x < box[2] - 1; x++) {
      const p = y * ww + x
      if (!mask[p]) continue
      area++
      if (!mask[p - 1] || !mask[p + 1] || !mask[p - ww] || !mask[p + ww]) perimeter++
    }
  }
  return perimeter ? (2 * area) / perimeter / capHeight : 0.12
}

/** The shear that best straightens the strokes: vertical strokes then pile up in few columns. */
function measureSlant(own: Uint8Array, ww: number, bands: { y0: number; y1: number }[], box: Box): number {
  const pixels: [number, number][] = []
  for (const band of bands) {
    const mid = (band.y0 + band.y1) / 2
    for (let y = band.y0; y < band.y1; y++) {
      for (let x = box[0]; x < box[2]; x++) if (own[y * ww + x]) pixels.push([x, y - mid])
    }
  }
  if (pixels.length < 50) return 0
  const width = box[2] - box[0]
  let best = 0
  let bestScore = -1
  for (let s = -0.15; s <= 0.4001; s += 0.025) {
    const columns = new Float32Array(width + 64)
    for (const [x, dy] of pixels) {
      const c = Math.round(x - box[0] + s * dy) + 32
      if (c >= 0 && c < columns.length) columns[c]++
    }
    let score = 0
    for (const v of columns) score += v * v
    if (score > bestScore) (bestScore = score), (best = s)
  }
  return Math.round(best * 1000) / 1000
}

function bestCluster(
  contrast: Uint8Array,
  gray: Uint8Array,
  ww: number,
  wh: number,
  near: Box,
  area: Box,
  expected: number,
  W: number,
  letter: number,
  strongInk: number,
  dark: boolean
): Cluster | null {
  // Glyphs are found on strong ink only (faint halos would weld neighbouring letters together);
  // the faint ink is used for the background test and, later, to erase anti-aliased edges.
  const ink = new Uint8Array(ww * wh)
  const strong = new Uint8Array(ww * wh)
  for (let p = 0; p < ink.length; p++) {
    ink[p] = contrast[p] > INK_WEAK ? 1 : 0
    strong[p] = contrast[p] > strongInk ? 1 : 0
  }
  const { labels, comps } = components(strong, ww, wh)

  const maxH = W * 0.1
  const candidates = comps.filter(
    (c) =>
      c.count >= 3 &&
      c.h >= 2 &&
      c.h <= maxH &&
      c.w <= W * 0.5 &&
      c.w <= c.h * 10 + 4 &&
      c.h <= c.w * 8 + 4 &&
      // Outlines and speed lines are thin strokes spread over a large box.
      c.count >= c.w * c.h * 0.1 &&
      isGlyph(c, gray, ink, labels, ww, wh)
  )
  if (!candidates.length) return null

  // Specks (JPEG noise on dark backgrounds, punctuation) would chain the lettering to nearby artwork;
  // they only join once the text lines are known.
  // The estimate from the model's box is too big when the box is loose; the ink inside it (weighted by
  // pixels, so noise does not count) tells the real letter size.
  const inside = candidates.filter((c) => c.x1 > near[0] && c.x0 < near[2] && c.y1 > near[1] && c.y0 < near[3])
  const typical = weightedMedian(inside.map((c) => c.h), inside.map((c) => c.count))
  const speck = Math.max(3, Math.min(letter, typical || letter) * 0.3)
  const seeds = candidates.filter((c) => Math.max(c.w, c.h) >= speck)
  const specks = candidates.filter((c) => Math.max(c.w, c.h) < speck)

  // Lettering is lines of similar glyphs side by side, stacked with a similar letter height. Grouping by
  // plain proximity would chain the text to strokes touching it (a sword crossing the box, the rays of
  // a burst bubble, the bubble's own outline).
  const parent = seeds.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < seeds.length; i++) {
    const a = seeds[i]
    for (let j = i + 1; j < seeds.length; j++) {
      const b = seeds[j]
      const lo = Math.min(a.h, b.h)
      const hi = Math.max(a.h, b.h)
      const sameRow = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) >= 0.5 * lo && hi <= 1.8 * lo
      if (sameRow && gapX(a, b) <= 0.9 * hi) parent[find(i)] = find(j)
    }
  }
  const lines = groupBy(seeds, (_, i) => find(i)).map((list) => ({ list, box: boundsOf(list), h: quantile(list.map((c) => c.h), 0.6) }))
  const stack = lines.map((_, i) => i)
  const top0 = (i: number): number => (stack[i] === i ? i : (stack[i] = top0(stack[i])))
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j]
      const lo = Math.min(a.h, b.h)
      const hi = Math.max(a.h, b.h)
      if (hi > 1.45 * lo) continue
      const wide = a.box[2] - a.box[0] >= 1.2 * a.h && b.box[2] - b.box[0] >= 1.2 * b.h
      const dy = Math.max(b.box[1] - a.box[3], a.box[1] - b.box[3])
      const overlapX = Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0])
      const minW = Math.min(a.box[2] - a.box[0], b.box[2] - b.box[0])
      if (wide && dy <= hi && dy >= -0.3 * lo && overlapX >= 0.3 * minW) stack[top0(i)] = top0(j)
    }
  }
  const groups = new Map<number, Comp[]>()
  lines.forEach((line, i) => {
    const root = top0(i)
    groups.set(root, [...(groups.get(root) ?? []), ...line.list])
  })

  const summarize = (list: Comp[]) => {
    const bbox = boundsOf(list)
    const letterHeight = Math.max(3, quantile(list.map((c) => c.h), 0.6))
    const size = Math.max(1, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
    // Touching letters form one component; estimate how many characters each one holds.
    const chars = list.reduce((n, c) => n + Math.max(1, Math.round(c.w / (c.h * 0.75))), 0)
    const ratio = chars / expected
    const textness = Math.min(ratio, 1 / ratio)
    // A few specks inside the model's box must not beat the real lettering a line away.
    const trust = Math.min(1, textness * 3)
    const score = 3 * textness + trust * (1.5 * (overlapArea(bbox, near) / size) + overlapArea(bbox, area) / size)
    return { bbox, letterHeight, score, textness, ovNear: overlapArea(bbox, near) / size }
  }

  let bestList: Comp[] | null = null
  let bestInfo: ReturnType<typeof summarize> | null = null
  const scored = [...groups.values()]
    .filter((list) => list.length >= 2 || expected <= 2)
    .map((list) => ({ list, info: summarize(list) }))
  // A row of dots ("...", the dot of a "?") counts like letters but sits beside the real lettering,
  // several times taller.
  const tallest = Math.max(0, ...scored.filter((s) => s.info.textness >= 0.3 && s.info.ovNear >= 0.5).map((s) => s.info.letterHeight))
  for (const { list, info } of scored) {
    const score = info.letterHeight < 0.4 * tallest ? info.score - 1.5 * info.textness : info.score
    if (!bestInfo || score > bestInfo.score) (bestList = list), (bestInfo = { ...info, score })
  }
  if (!bestList || !bestInfo) return null
  if (bestInfo.textness < 0.12 && bestInfo.ovNear < 0.3) return null
  // Lines set further apart than the grouping distance end up in separate groups; pull them back in.
  // The model's box can be a line or two off, but not more: artwork further away (a sword crossing the
  // box, the bubble's outline) stays out.
  let merged = bestList
  const seedBox = boundsOf(bestList)
  const seedH = quantile(bestList.map((c) => c.h), 0.6)
  const slack = Math.max(2.5 * seedH, 0.5 * (near[3] - near[1]))
  const top = Math.min(near[1], seedBox[1]) - slack
  const bottom = Math.max(near[3], seedBox[3]) + slack
  let changed = true
  while (changed) {
    changed = false
    const box = boundsOf(merged)
    const h0 = quantile(merged.map((c) => c.h), 0.6)
    for (const list of groups.values()) {
      if (list === bestList || list.length < 2 || list.some((c) => merged.includes(c))) continue
      const other = boundsOf(list)
      if (other[1] < top || other[3] > bottom) continue
      const oh = quantile(list.map((c) => c.h), 0.6)
      if (Math.max(oh, h0) / Math.max(1, Math.min(oh, h0)) > 1.7) continue
      // Text comes in lines; the spikes lining a bubble's border form one tall slanted chain.
      const bands = textBands(list, oh)
      if (bands.some((b) => b.y1 - b.y0 > oh * 1.8)) continue
      const overlapX = Math.min(other[2], box[2]) - Math.max(other[0], box[0])
      const dy = Math.max(0, other[1] - box[3], box[1] - other[3])
      // Lines of one block are centred on each other, or share a left or right edge.
      const aligned =
        Math.abs((other[0] + other[2]) / 2 - (box[0] + box[2]) / 2) <= (box[2] - box[0]) * 0.2 ||
        Math.abs(other[0] - box[0]) <= h0 ||
        Math.abs(other[2] - box[2]) <= h0
      // A line of text is a few letters wide at least; fragments of a stroke are not.
      const lineLike = Math.max(oh, h0) / Math.max(1, Math.min(oh, h0)) <= 1.45 && bands.every((b) => b.x1 - b.x0 >= 2 * oh)
      const stacked =
        aligned && lineLike && overlapX >= 0.5 * Math.min(other[2] - other[0], box[2] - box[0]) && dy <= h0 * 1.8
      // Same text line, split by something crossing it.
      const sameLine =
        other[3] - other[1] <= h0 * 1.6 &&
        list.some((c) =>
          merged.some(
            (m) => Math.min(c.y1, m.y1) - Math.max(c.y0, m.y0) >= 0.5 * Math.min(c.h, m.h) && gapX(c, m) <= h0 * 2.5
          )
        )
      if ((stacked || sameLine) && merged.length + list.length <= expected * 1.6) {
        merged = [...merged, ...list]
        changed = true
      }
    }
  }

  // Punctuation and other small marks belong to the block when they sit in one of its lines; a mark
  // extends the line, so "...?" is reached dot by dot.
  const h1 = quantile(merged.map((c) => c.h), 0.6)
  const loose = new Set([...groups.values()].filter((l) => l.length === 1 || quantile(l.map((c) => c.h), 0.6) < 0.4 * tallest).flat())
  const marks = candidates.filter((c) => !merged.includes(c) && (specks.includes(c) || (loose.has(c) && Math.max(c.w, c.h) <= h1 * 1.2)))
  const lineBands = textBands(merged, h1).map((b) => ({ ...b, left: b.x0 - h1 * 3, right: b.x1 + h1 * 3 }))
  for (let added = true; added; ) {
    added = false
    for (const c of marks) {
      if (merged.includes(c)) continue
      const band = lineBands.find(
        (b) =>
          c.y0 >= b.y0 - h1 * 0.3 &&
          c.y1 <= b.y1 + h1 * 0.3 &&
          c.x0 >= Math.max(b.left, b.x0 - h1 * 1.5) &&
          c.x1 <= Math.min(b.right, b.x1 + h1 * 1.5)
      )
      if (!band) continue
      merged = [...merged, c]
      band.x0 = Math.min(band.x0, c.x0)
      band.x1 = Math.max(band.x1, c.x1)
      added = true
    }
  }

  const info = summarize(merged)
  const accepted = new Set(candidates.map((c) => c.id))
  return {
    comps: merged,
    bbox: info.bbox,
    letterHeight: Math.max(3, h1),
    score: info.score,
    textness: info.textness,
    labels,
    ink,
    rejected: comps.filter((c) => !accepted.has(c.id) && c.count >= 3),
    dark
  }
}

/** Text lines of a cluster: merged row ranges of its glyphs, with their horizontal extent. */
function textBands(comps: Comp[], h0: number): { y0: number; y1: number; x0: number; x1: number }[] {
  const sorted = [...comps].filter((c) => c.h >= h0 * 0.5).sort((a, b) => a.y0 - b.y0)
  const bands: { y0: number; y1: number; x0: number; x1: number }[] = []
  for (const c of sorted) {
    const last = bands[bands.length - 1]
    if (last && c.y0 < last.y1 - h0 * 0.3) {
      last.y1 = Math.max(last.y1, c.y1)
      last.x0 = Math.min(last.x0, c.x0)
      last.x1 = Math.max(last.x1, c.x1)
    } else {
      bands.push({ y0: c.y0, y1: c.y1, x0: c.x0, x1: c.x1 })
    }
  }
  return bands
}

/** [start, end) ranges of set entries, bridging gaps up to `maxGap`. */
function runs(values: Uint8Array, maxGap: number): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  let end = -1
  for (let i = 0; i < values.length; i++) {
    if (!values[i]) continue
    if (start >= 0 && i - end <= maxGap) end = i + 1
    else {
      if (start >= 0) out.push([start, end])
      start = i
      end = i + 1
    }
  }
  if (start >= 0) out.push([start, end])
  return out
}

// ---------------------------------------------------------------------------------------------------
// Erasing
// ---------------------------------------------------------------------------------------------------

/** Rebuilds the background under the glyphs from the surrounding pixels (works on gradients and art too). */
function erase(ctx: CanvasRenderingContext2D, g: Glyphs): void {
  if (!g.bbox) return
  const { win, ww, wh } = g
  // Wide enough to cover the outline, the anti-aliasing and JPEG ringing around the strokes, plus a ring
  // of glow that is repainted but never sampled: copying it inwards draws streaks.
  const outline = g.look?.outline ? g.look.outlineRatio * g.look.capHeight : 0
  const grow = Math.max(1, Math.round(g.letterHeight * 0.18 + outline)) + 1
  const halo = Math.max(1, Math.round(g.letterHeight * 0.12))
  const mask = dilate(g.mask, ww, wh, (grow + halo) * 2 + 1)
  const image = ctx.getImageData(win[0], win[1], ww, wh)
  fillMasked(image.data, ww, wh, mask, g.ink, Math.max(3, Math.round(g.letterHeight * 0.6)))
  ctx.putImageData(image, win[0], win[1])
}

/**
 * Normalized convolution: each masked pixel becomes the mean of the flat pixels in a square around it,
 * widened until enough of them are found, then the fill is blurred once to hide where it widened.
 * Smooth backgrounds and gradients come back without the streaks of edge-to-centre diffusion; strokes
 * (bubble borders, other text, artwork lines) barely count, so they do not smear into the fill.
 */
function fillMasked(d: Uint8ClampedArray, ww: number, wh: number, mask: Uint8Array, ink: Uint8Array, radius: number): void {
  const masked: number[] = []
  for (let p = 0; p < mask.length; p++) if (mask[p]) masked.push(p)
  if (!masked.length) return
  const known = integrals(d, ww, wh, (p) => (mask[p] || ink[p] ? 0 : 1))
  const colors = new Float32Array(masked.length * 3)
  const filled = new Uint8Array(masked.length)
  let todo = masked.map((_, n) => n)
  for (const r of [radius, radius * 2]) {
    const next: number[] = []
    for (const n of todo) {
      const p = masked[n]
      const x = p % ww
      const y = (p - x) / ww
      const s = boxSum(known, ww, wh, x, y, r)
      if (s[3] < 0.15 * (2 * r + 1) ** 2) {
        next.push(n)
        continue
      }
      colors[n * 3] = s[0] / s[3]
      colors[n * 3 + 1] = s[1] / s[3]
      colors[n * 3 + 2] = s[2] / s[3]
      filled[n] = 1
    }
    todo = next
  }
  // The middle of a large erased block is far from any background; a wider mean would reach the
  // bubble's border and the art outside it. It grows in from the nearest filled pixels instead.
  if (todo.length) {
    const index = new Int32Array(ww * wh).fill(-1)
    masked.forEach((p, n) => (index[p] = n))
    const valueAt = (p: number, c: number) => (mask[p] ? colors[index[p] * 3 + c] : d[p * 4 + c])
    for (let strokes = false; todo.length; ) {
      const next: number[] = []
      const updates: [number, number, number, number][] = []
      for (const n of todo) {
        const p = masked[n]
        const x = p % ww
        const y = (p - x) / ww
        let r = 0
        let g = 0
        let b = 0
        let count = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue
            const q = ny * ww + nx
            if (mask[q] ? !filled[index[q]] : ink[q] && !strokes) continue
            r += valueAt(q, 0)
            g += valueAt(q, 1)
            b += valueAt(q, 2)
            count++
          }
        }
        if (count) updates.push([n, r / count, g / count, b / count])
        else next.push(n)
      }
      for (const [n, r, g, b] of updates) {
        colors[n * 3] = r
        colors[n * 3 + 1] = g
        colors[n * 3 + 2] = b
        filled[n] = 1
      }
      // Walled in by strokes only: take them rather than leave a hole.
      if (!updates.length) {
        if (strokes) break
        strokes = true
      }
      todo = next
    }
  }
  const write = () =>
    masked.forEach((p, n) => {
      if (!filled[n]) return
      d[p * 4] = colors[n * 3]
      d[p * 4 + 1] = colors[n * 3 + 1]
      d[p * 4 + 2] = colors[n * 3 + 2]
    })
  write()
  // Pixels the fill could not reach (busy art behind lettering) would otherwise stay as dark smudges.
  masked.forEach((p, n) => {
    if (!filled[n]) {
      d[p * 4] = 255
      d[p * 4 + 1] = 255
      d[p * 4 + 2] = 255
    }
  })

  const flat = integrals(d, ww, wh, (p) => (mask[p] || !ink[p] ? 1 : 0))
  const smooth = Math.max(1, radius >> 1)
  masked.forEach((p, n) => {
    if (!filled[n]) return
    const x = p % ww
    const y = (p - x) / ww
    const s = boxSum(flat, ww, wh, x, y, smooth)
    if (!s[3]) return
    colors[n * 3] = s[0] / s[3]
    colors[n * 3 + 1] = s[1] / s[3]
    colors[n * 3 + 2] = s[2] / s[3]
  })
  write()
}

/** Summed-area tables of r, g, b (weighted) and weight; (ww + 1) × (wh + 1), 4 values per entry. */
function integrals(d: Uint8ClampedArray, ww: number, wh: number, weight: (p: number) => number): Float64Array {
  const stride = ww + 1
  const t = new Float64Array(stride * (wh + 1) * 4)
  for (let y = 0; y < wh; y++) {
    const row = [0, 0, 0, 0]
    for (let x = 0; x < ww; x++) {
      const p = y * ww + x
      const w = weight(p)
      row[0] += d[p * 4] * w
      row[1] += d[p * 4 + 1] * w
      row[2] += d[p * 4 + 2] * w
      row[3] += w
      const i = ((y + 1) * stride + x + 1) * 4
      const above = (y * stride + x + 1) * 4
      for (let k = 0; k < 4; k++) t[i + k] = t[above + k] + row[k]
    }
  }
  return t
}

/** Sums of a summed-area table over the square of radius r around (x, y), clipped to the image. */
function boxSum(t: Float64Array, ww: number, wh: number, x: number, y: number, r: number): number[] {
  const stride = ww + 1
  const x0 = Math.max(0, x - r)
  const y0 = Math.max(0, y - r)
  const x1 = Math.min(ww, x + r + 1)
  const y1 = Math.min(wh, y + r + 1)
  const a = (y0 * stride + x0) * 4
  const b = (y0 * stride + x1) * 4
  const c = (y1 * stride + x0) * 4
  const e = (y1 * stride + x1) * 4
  return [0, 1, 2, 3].map((k) => t[e + k] - t[b + k] - t[c + k] + t[a + k])
}

// ---------------------------------------------------------------------------------------------------
// Typesetting
// ---------------------------------------------------------------------------------------------------

/** Fraction of the bubble width/height the translation may use. */
const FILL = 0.84

interface Profile {
  /** Usable width of each row (symmetric around cx), indexed from `top`. */
  widths: Float32Array
  top: number
  cx: number
  cy: number
  /** Rows around cy available to the translation. */
  spanTop: number
  spanBottom: number
  /** Width / height of the free space around the text. */
  aspect: number
  /** The free space clearly narrows towards its top and bottom like a bubble. */
  round: boolean
  /** The free space clearly keeps its width above and below the text, like a box. */
  square: boolean
  bg: RGB
}

interface Style {
  family: string
  weight: number
  /** Horizontal scale and shear applied to the face to match the original's width and slant. */
  scaleX: number
  slant: number
  /** Extra stroke thickness in the fill colour (faux bold) / cap height. */
  bold: number
  fill: string
  stroke: string | null
  /** Outline thickness / cap height. */
  strokeRatio: number
  /** Cap height / font size of this face. */
  capRatio: number
  /** Line pitch / cap height. */
  pitch: number
  /** Line widths follow an ellipse (bubbles) or stay even (boxes, captions). */
  shape: 'ellipse' | 'box'
}

/** Writes the translation where the original was, in lettering that resembles the original's. */
function typeset(
  ctx: CanvasRenderingContext2D,
  block: TextBlock,
  g: Glyphs,
  W: number,
  H: number
): { capHeight: number; fontSize: number; family: string } {
  const text = matchCase(block.translation, block.original)
  const look = g.look
  const textBox = g.bbox ?? block.textBox
  const capHeight = look?.capHeight ?? block.letterHeight ?? estimateLetter(block) * 0.9
  const profile = measureBubble(ctx, block, textBox, g.bbox !== null, capHeight, W, H)
  const style = resolveStyle(ctx, block, look, profile)
  // Between the original's proportions and the bubble's: a one-line original in a round bubble becomes
  // a few lines, never a narrow column.
  const targetAspect = look ? clamp(Math.sqrt(look.aspect * profile.aspect), profile.aspect, profile.aspect * 2.5) : profile.aspect
  // Same cap height as the original; smaller only when the translation does not fit otherwise.
  const maxFont = Math.max(MIN_FONT, Math.min(capHeight / style.capRatio, Math.max(14, W / 10)))

  let best: Layout | null = null
  for (const hyphenate of [false, true]) {
    let lo = MIN_FONT
    let hi = Math.floor(maxFont)
    while (lo <= hi) {
      const size = (lo + hi) >> 1
      const layout = layoutAt(ctx, text, size, profile, style, targetAspect, hyphenate)
      if (layout) (best = layout), (lo = size + 1)
      else hi = size - 1
    }
    if (best) {
      // A slightly smaller font is worth it when the block then follows the bubble's shape much better.
      const largest: Layout = best
      for (let size = largest.size - 1; size >= Math.max(MIN_FONT, largest.size * 0.85); size--) {
        const layout = layoutAt(ctx, text, size, profile, style, targetAspect, hyphenate)
        if (layout && layout.cost + 2 * (1 - size / largest.size) < best.cost) best = layout
      }
      break
    }
  }
  const layout = best ?? forcedLayout(ctx, text, profile, style)

  const cap = style.capRatio * layout.size
  const bold = style.bold * cap
  const draw = (paint: (line: string) => void) => {
    layout.lines.forEach((line, i) => {
      const baseline = layout.ys[i] + cap / 2
      // Shearing leans the letters around the baseline; shift back so the line stays centred.
      ctx.setTransform(style.scaleX, 0, -style.slant, 1, profile.cx - (style.slant * cap) / 2, baseline)
      paint(line)
    })
  }
  ctx.save()
  ctx.font = fontSpec(style, layout.size)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  if (style.stroke) {
    ctx.strokeStyle = style.stroke
    ctx.lineWidth = Math.max(1.5, 2 * style.strokeRatio * cap) + bold
    draw((line) => ctx.strokeText(line, 0, 0))
  }
  if (bold >= 0.4) {
    ctx.strokeStyle = style.fill
    ctx.lineWidth = bold
    draw((line) => ctx.strokeText(line, 0, 0))
  }
  ctx.fillStyle = style.fill
  draw((line) => ctx.fillText(line, 0, 0))
  ctx.restore()
  return { capHeight: Math.round(capHeight), fontSize: layout.size, family: style.family }
}

/** Picks the bundled face, weight, colours and spacing closest to the original lettering. */
function resolveStyle(ctx: CanvasRenderingContext2D, block: TextBlock, look: Look | null, profile: Profile): Style {
  const text = originalLine(block)
  const face = FONTS[chooseRole(block, look, text)]
  // As wide as the original for the same text, at the same cap height.
  const widthOf = (w: number) => (look ? clamp(look.span / faceInk(face.family, w, text).span, 0.7, 1.15) : 1)
  // The weight whose text lines are as dark as the original's, for the same text (squeezing keeps the
  // density); faux bold makes up for what the heaviest weight lacks.
  const inkOf = (w: number) => {
    const sx = widthOf(w)
    const m = faceInk(face.family, w, text)
    return { ink: m.ink, perimeter: (m.perimeter * (1 + sx)) / 2 / sx }
  }
  let weight = face.weights[Math.min(face.weights.length - 1, 1)]
  if (look) {
    let gap = Infinity
    for (const w of face.weights) {
      const d = Math.abs(Math.log(inkOf(w).ink / Math.max(0.01, look.ink)))
      if (d < gap) (gap = d), (weight = w)
    }
  }
  const metrics = faceMetrics(ctx, face.family, weight)
  const chosen = inkOf(weight)
  // Below this the measured lean is noise from the hand lettering.
  const leaning = look ? (look.slant >= 0.08 ? look.slant : 0) : block.italic ? 0.2 : 0
  const lightBg = luminance(profile.bg) > 140
  return {
    family: face.family,
    weight,
    scaleX: widthOf(weight),
    slant: leaning - metrics.slant,
    // Stroking the outline with width b adds about outline length Ã— b / 2 of ink.
    bold: look ? clamp((2 * (look.ink - chosen.ink)) / Math.max(0.1, chosen.perimeter), 0, 0.08) : 0,
    fill: look ? toHex(look.fill) : (block.color ?? (lightBg ? '#111111' : '#ffffff')),
    stroke: look ? (look.outline ? toHex(look.outline) : null) : (block.outline ?? null),
    strokeRatio: look?.outline ? clamp(look.outlineRatio, 0.08, 0.3) : 0.15,
    capRatio: metrics.capRatio,
    pitch: look && look.pitch > 0 ? clamp(look.pitch / look.capHeight, 1.3, 2.1) : LINE_PITCH,
    shape: shapeOf(block, profile)
  }
}

/**
 * Speech is lettered in an ellipse unless its space is clearly a box (bubbles cut by the page edge or
 * merged with the background still count as bubbles); captions and system windows only in round bubbles.
 */
function shapeOf(block: TextBlock, profile: Profile): Style['shape'] {
  if (block.kind === 'system' || profile.square) return 'box'
  if (profile.round) return 'ellipse'
  return block.kind === 'narration' || block.kind === 'sfx' || block.kind === 'other' ? 'box' : 'ellipse'
}

/**
 * The lettering style read from the original's pixels: leaning hand lettering, narrow upright type
 * (system windows, captions) or regular comic lettering; very heavy strokes are shouts. The model's
 * hint decides when there are no pixels, and for serif type, which the measurements cannot tell apart.
 */
function chooseRole(block: TextBlock, look: Look | null, text: string): FontRole {
  if (!look) return block.font ?? (block.kind === 'aside' ? 'handwritten' : block.kind === 'system' ? 'condensed' : 'comic')
  if (block.font === 'serif') return 'serif'
  if (look.slant >= 0.12) return look.weight > 0.2 ? 'brush' : 'handwritten'
  // Comic lettering is narrower than Comic Neue, but not by this much.
  const comic = FONTS.comic
  const narrow = look.span / faceInk(comic.family, comic.weights[comic.weights.length - 1], text).span < 0.6
  return narrow ? 'condensed' : 'comic'
}

/** The original text as the single line its glyphs were measured against. */
function originalLine(block: TextBlock): string {
  return block.original.replace(/\s+/g, ' ').trim()
}

interface FaceMetrics {
  capRatio: number
  /** Stroke thickness / cap height. */
  weight: number
  /** Average advance per character of capitals and spaces / cap height. */
  advance: number
  /** Lean of the face's own capitals, as measured by `measureSlant`. */
  slant: number
}

const metricsCache = new Map<string, FaceMetrics>()
const inkCache = new Map<string, { ink: number; perimeter: number; span: number }>()

/** Ink mass / (cap height Ã— line width) and outline length / line width of `text` set in a face. */
function faceInk(family: string, weight: number, text: string): { ink: number; perimeter: number; span: number } {
  const key = `${family}|${weight}|${text}`
  const cached = inkCache.get(key)
  if (cached) return cached
  const size = 60
  const canvas = document.createElement('canvas')
  const c = canvas.getContext('2d', { willReadFrequently: true })!
  c.font = `${weight} ${size}px ${family}`
  const cap = c.measureText('H').actualBoundingBoxAscent || size * 0.7
  const width = Math.max(1, c.measureText(text).width)
  canvas.width = Math.ceil(width) + 40
  canvas.height = size * 2
  c.fillStyle = '#fff'
  c.fillRect(0, 0, canvas.width, canvas.height)
  c.fillStyle = '#000'
  c.font = `${weight} ${size}px ${family}`
  c.fillText(text, 20, size * 1.4)
  const d = c.getImageData(0, 0, canvas.width, canvas.height).data
  const ww = canvas.width
  const mask = new Uint8Array(ww * canvas.height)
  let mass = 0
  for (let p = 0; p < mask.length; p++) {
    mass += (255 - d[p * 4]) / 255
    if (d[p * 4] < 128) mask[p] = 1
  }
  let perimeter = 0
  for (let y = 1; y < canvas.height - 1; y++) {
    for (let x = 1; x < ww - 1; x++) {
      const p = y * ww + x
      if (mask[p] && (!mask[p - 1] || !mask[p + 1] || !mask[p - ww] || !mask[p + ww])) perimeter++
    }
  }
  const result = { ink: mass / (cap * width), perimeter: perimeter / width, span: width / cap }
  inkCache.set(key, result)
  return result
}

/** Measures a face the same way `measureLook` measures the original lettering. */
function faceMetrics(ctx: CanvasRenderingContext2D, family: string, weight: number): FaceMetrics {
  const key = `${family}|${weight}`
  const cached = metricsCache.get(key)
  if (cached) return cached
  const size = 100
  const font = `${weight} ${size}px ${family}`
  const sample = 'THE QUICK BROWN FOX JUMPS OVER'
  ctx.save()
  ctx.font = font
  const cap = ctx.measureText('H').actualBoundingBoxAscent || size * 0.7
  const advance = ctx.measureText(sample).width / sample.length / cap
  ctx.restore()

  const canvas = document.createElement('canvas')
  canvas.width = 1400
  canvas.height = 160
  const c = canvas.getContext('2d', { willReadFrequently: true })!
  c.fillStyle = '#fff'
  c.fillRect(0, 0, canvas.width, canvas.height)
  c.fillStyle = '#000'
  c.font = font
  c.textBaseline = 'alphabetic'
  c.fillText('HAMBURGEFONSTIV', 20, 130)
  const d = c.getImageData(0, 0, canvas.width, canvas.height).data
  const own = new Uint8Array(canvas.width * canvas.height)
  for (let p = 0; p < own.length; p++) if (d[p * 4] < 128) own[p] = 1
  const band = { y0: Math.round(130 - cap), y1: 130 }
  const metrics = {
    capRatio: cap / size,
    weight: strokeWeight(own, canvas.width, [0, 0, canvas.width, canvas.height], cap),
    advance,
    slant: measureSlant(own, canvas.width, [band], [0, band.y0, canvas.width, band.y1])
  }
  metricsCache.set(key, metrics)
  return metrics
}

/**
 * Measures, row by row, how wide the free space is around the original text (on the already-cleaned
 * image), and where its middle is. Rows where the original text was are at least as wide as that text.
 */
function measureBubble(
  ctx: CanvasRenderingContext2D,
  block: TextBlock,
  textBox: Box,
  measured: boolean,
  letterHeight: number,
  W: number,
  H: number
): Profile {
  const size = Math.max(block.areaBox[2] - block.areaBox[0], block.areaBox[3] - block.areaBox[1])
  const limit = roundBox(clampBox(union(expand(block.areaBox, size * 0.08), expand(textBox, letterHeight * 2)), W, H))
  const lw = limit[2] - limit[0]
  const lh = limit[3] - limit[1]
  let cx = Math.round((textBox[0] + textBox[2]) / 2)
  const cy = Math.round((textBox[1] + textBox[3]) / 2)
  const widths = new Float32Array(Math.max(0, lh))
  if (lw < 4 || lh < 4) {
    return { widths, top: limit[1], cx, cy, spanTop: cy, spanBottom: cy, aspect: 1, round: false, square: false, bg: [255, 255, 255] }
  }

  const d = ctx.getImageData(limit[0], limit[1], lw, lh).data
  const local = roundBox(clampBox([textBox[0] - limit[0], textBox[1] - limit[1], textBox[2] - limit[0], textBox[3] - limit[1]], lw, lh))
  const bg = medianColor(d, lw, local) as RGB
  const isBg = (x: number, y: number) => {
    const i = (y * lw + x) * 4
    return Math.abs(d[i] - bg[0]) <= BG_TOLERANCE && Math.abs(d[i + 1] - bg[1]) <= BG_TOLERANCE && Math.abs(d[i + 2] - bg[2]) <= BG_TOLERANCE
  }
  // The original lettering is erased by now; a wider gap would step over the bubble's border into the
  // page around it when that is the same colour.
  const gap = Math.max(1, Math.round(letterHeight * 0.04))
  const lefts = new Int32Array(lh)
  const rights = new Int32Array(lh)
  const scan = (from: number) => {
    for (let y = 0; y < lh; y++) {
      let left = from
      let miss = 0
      for (let x = from - 1; x >= 0 && miss <= gap; x--) {
        if (isBg(x, y)) (left = x), (miss = 0)
        else miss++
      }
      let right = from
      miss = 0
      for (let x = from + 1; x < lw && miss <= gap; x++) {
        if (isBg(x, y)) (right = x), (miss = 0)
        else miss++
      }
      lefts[y] = left
      rights[y] = right
    }
  }
  // Text is centred in its bubble; when the bubble is closed on both sides, centre on the bubble.
  let lcx = clamp(cx - limit[0], 0, lw - 1)
  scan(lcx)
  const mids: number[] = []
  for (let y = Math.max(0, local[1]); y < Math.min(lh, local[3]); y++) {
    if (lefts[y] > 0 && rights[y] < lw - 1) mids.push((lefts[y] + rights[y]) / 2)
  }
  if (mids.length > (local[3] - local[1]) * 0.6) {
    const mid = Math.round(quantile(mids, 0.5))
    // Measured lettering was centred by the original letterer; art crossing the bubble can fool the
    // bubble's edges more than that. The model's box is rougher.
    const tolerance = measured ? letterHeight : (local[2] - local[0]) * 0.25 + letterHeight
    if (Math.abs(mid - lcx) <= tolerance) {
      lcx = mid
      cx = mid + limit[0]
      scan(lcx)
    }
  }
  for (let y = 0; y < lh; y++) {
    widths[y] = !isBg(lcx, y) && rights[y] - lefts[y] < gap * 2 ? 0 : 2 * Math.min(lcx - lefts[y], rights[y] - lcx)
  }

  // The original text fitted there (art it overlapped included), so the translation may use at least
  // that much room.
  const textWidth = (textBox[2] - textBox[0]) / FILL
  const reachY = Math.round(letterHeight * 0.5)
  for (let y = Math.max(0, local[1] - reachY); y < Math.min(lh, local[3] + reachY); y++) widths[y] = Math.max(widths[y], textWidth)

  const lcy = clamp(cy - limit[1], 0, lh - 1)
  const minRow = Math.max(4, letterHeight * 0.8)
  let spanTop = lcy
  let spanBottom = lcy
  while (spanTop > 0 && widths[spanTop - 1] >= minRow) spanTop--
  while (spanBottom < lh - 1 && widths[spanBottom + 1] >= minRow) spanBottom++

  // Bubble height from the side that closes first: an ellipse is 55% as wide as its centre at 0.84 of its
  // half-height. Bubbles open on one side (merged with a white background) would otherwise look endless.
  const centre = widths[lcy]
  let up = lcy
  let down = lcy
  while (up > spanTop && widths[up - 1] >= centre * 0.55) up--
  while (down < spanBottom && widths[down + 1] >= centre * 0.55) down++
  const half = Math.max(letterHeight * 1.5, Math.min(lcy - up, down - lcy) / 0.84)
  const reach = Math.max(half, (local[3] - local[1]) / 2 + letterHeight)
  spanTop = Math.max(spanTop, Math.floor(lcy - reach))
  spanBottom = Math.min(spanBottom + 1, Math.ceil(lcy + reach))

  // A bubble is clearly narrower above and below its middle (an ellipse: 80% at 0.6 of the half-height);
  // a box, or text floating on a flat background, is not.
  const probe = Math.round(half * 0.6)
  const side = [lcy - probe, lcy + probe].filter((y) => y >= 0 && y < lh).map((y) => widths[y])
  const closed = lefts[lcy] > 0 && rights[lcy] < lw - 1
  const round = closed && side.length > 0 && Math.max(...side) < centre * 0.9
  const square = closed && side.length === 2 && Math.min(...side) >= centre * 0.97

  return {
    widths,
    top: limit[1],
    cx,
    cy,
    spanTop: spanTop + limit[1],
    spanBottom: spanBottom + limit[1],
    aspect: centre / (2 * half),
    round,
    square,
    bg
  }
}

interface Layout {
  size: number
  lines: string[]
  ys: number[]
  cost: number
}

/**
 * Best line breaking at a given font size: lines must fit the free space, and their widths should follow
 * an ellipse in bubbles (short first and last lines, long middle ones) or stay even in boxes, with
 * proportions between the original block's and the bubble's.
 */
function layoutAt(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  profile: Profile,
  style: Style,
  targetAspect: number,
  hyphenate: boolean
): Layout | null {
  ctx.font = fontSpec(style, size)
  const lineH = style.capRatio * size * style.pitch
  const spanH = (profile.spanBottom - profile.spanTop) * FILL
  // Leaning letters stick out by their lean on one side.
  const lean = Math.abs(style.slant) * style.capRatio * size
  const usable = (y0: number, y1: number) => rowWidth(profile, y0, y1) * FILL - lean
  const centreWidth = usable(profile.cy - lineH / 2, profile.cy + lineH / 2)
  if (centreWidth <= 0 || lineH > spanH) return null

  // Boxes keep the translation's own line breaks (a status window's title and fields); bubbles are
  // re-broken to their shape.
  const paragraphs = style.shape === 'box' ? text.split(/\s*\n\s*/) : [text]
  const words: string[] = []
  const starts = new Set<number>()
  for (const paragraph of paragraphs) {
    const list = hyphenate ? splitWords(ctx, paragraph, centreWidth / style.scaleX) : paragraph.split(/\s+/).filter(Boolean)
    if (!list?.length) continue
    if (words.length) starts.add(words.length)
    words.push(...list)
  }
  if (!words.length) return null
  const widths = words.map((w) => ctx.measureText(w).width * style.scaleX)
  const space = ctx.measureText(' ').width * style.scaleX
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1)

  let best: { cost: number; lines: string[]; ys: number[] } | null = null
  const maxLines = Math.min(words.length, Math.floor(spanH / lineH))
  for (let n = starts.size + 1; n <= maxLines; n++) {
    const blockH = n * lineH
    const centre = clamp(profile.cy, profile.spanTop + blockH / 2, profile.spanBottom - blockH / 2)
    const ys = Array.from({ length: n }, (_, i) => centre + (i - (n - 1) / 2) * lineH)
    const hard = ys.map((y) => usable(y - lineH / 2, y + lineH / 2))
    if (hard.some((h) => h <= 0)) continue

    const shape =
      style.shape === 'ellipse'
        ? ys.map((y) => Math.sqrt(Math.max(0.2, 1 - ((y - centre) / (blockH * 0.62)) ** 2)))
        : ys.map(() => 1)
    const scale = total / shape.reduce((a, b) => a + b, 0)
    const targets = shape.map((s) => s * scale)

    const result = breakLines(widths, space, hard, targets, starts)
    if (!result) continue
    const lineWidths = result.map(([a, b]) => span(widths, space, a, b))
    const blockW = Math.max(...lineWidths)
    let cost = result.cost + (style.shape === 'ellipse' ? 0.35 : 0.2) * Math.log(blockW / blockH / targetAspect) ** 2
    // A line shorter than both its neighbours breaks the outline of the block.
    for (let i = 1; i < n - 1 && !starts.size; i++) {
      const dip = Math.max(0, Math.min(lineWidths[i - 1], lineWidths[i + 1]) - lineWidths[i]) / blockW
      cost += 4 * dip * dip
    }
    if (!best || cost < best.cost) best = { cost, lines: result.map(([a, b]) => words.slice(a, b).join(' ')), ys }
  }
  return best ? { size, lines: best.lines, ys: best.ys, cost: best.cost } : null
}

/**
 * Partitions words into exactly hard.length lines; minimises the deviation from the target widths.
 * A line never runs past a word in `starts` (the first word of a paragraph).
 */
function breakLines(
  widths: number[],
  space: number,
  hard: number[],
  targets: number[],
  starts: Set<number>
): ([number, number][] & { cost: number }) | null {
  const m = widths.length
  const n = hard.length
  const nextStart = new Array<number>(m + 1).fill(m + 1)
  for (let a = m - 1; a >= 0; a--) nextStart[a] = starts.has(a + 1) ? a + 1 : nextStart[a + 1]
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity))
  const from: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-1))
  cost[0][0] = 0
  for (let i = 1; i <= n; i++) {
    for (let j = i; j <= m - (n - i); j++) {
      for (let a = i - 1; a < j; a++) {
        if (cost[i - 1][a] === Infinity || nextStart[a] < j) continue
        const w = span(widths, space, a, j)
        if (w > hard[i - 1]) continue
        const c = cost[i - 1][a] + ((w - targets[i - 1]) / targets[i - 1]) ** 2
        if (c < cost[i][j]) (cost[i][j] = c), (from[i][j] = a)
      }
    }
  }
  if (cost[n][m] === Infinity) return null
  const ranges: [number, number][] = []
  let j = m
  for (let i = n; i > 0; i--) {
    const a = from[i][j]
    ranges.unshift([a, j])
    j = a
  }
  return Object.assign(ranges, { cost: cost[n][m] })
}

/** Last resort when nothing fits: smallest font, plain greedy wrapping at the centre width. */
function forcedLayout(ctx: CanvasRenderingContext2D, text: string, profile: Profile, style: Style): Layout {
  ctx.font = fontSpec(style, MIN_FONT)
  const width = Math.max(40, rowWidth(profile, profile.cy - 4, profile.cy + 4) * FILL)
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word
    if (current && ctx.measureText(candidate).width * style.scaleX > width) lines.push(current), (current = word)
    else current = candidate
  }
  if (current) lines.push(current)
  const lineH = style.capRatio * MIN_FONT * style.pitch
  return { size: MIN_FONT, lines, ys: lines.map((_, i) => profile.cy + (i - (lines.length - 1) / 2) * lineH), cost: Infinity }
}

function span(widths: number[], space: number, a: number, b: number): number {
  let w = space * (b - a - 1)
  for (let i = a; i < b; i++) w += widths[i]
  return w
}

/** Narrowest usable width over the rows y0..y1 (canvas coordinates). */
function rowWidth(profile: Profile, y0: number, y1: number): number {
  const a = Math.floor(y0) - profile.top
  const b = Math.ceil(y1) - profile.top
  if (a < 0 || b > profile.widths.length) return 0
  let min = Infinity
  for (let y = a; y < b; y++) min = Math.min(min, profile.widths[y])
  return min === Infinity ? 0 : min
}

/** Words, with any word wider than `maxWidth` hyphenated into pieces. */
function splitWords(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] | null {
  const out: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (ctx.measureText(word).width <= maxWidth) {
      out.push(word)
      continue
    }
    let current = ''
    for (const char of word) {
      if (current && ctx.measureText(`${current}${char}-`).width > maxWidth) out.push(`${current}-`), (current = char)
      else current += char
    }
    if (current) out.push(current)
  }
  return out.length ? out : null
}

/** Lettering in all caps stays in all caps. */
function matchCase(translation: string, original: string): string {
  const letters = [...original].filter((c) => c.toLowerCase() !== c.toUpperCase())
  if (letters.length < 3) return translation
  const upper = letters.filter((c) => c === c.toUpperCase()).length
  return upper / letters.length > 0.85 ? translation.toLocaleUpperCase('pt-BR') : translation
}

function fontSpec(style: Style, size: number): string {
  return `${style.weight} ${size}px ${style.family}`
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** Median-luminance colour of the pixels inside `box`. */
function medianColor(d: Uint8ClampedArray, ww: number, box: Box): number[] {
  const samples: number[][] = []
  const step = Math.max(1, Math.round(Math.sqrt(((box[2] - box[0]) * (box[3] - box[1])) / 4000)))
  for (let y = box[1]; y < box[3]; y += step) {
    for (let x = box[0]; x < box[2]; x += step) {
      const i = (y * ww + x) * 4
      samples.push([d[i], d[i + 1], d[i + 2]])
    }
  }
  if (!samples.length) return [255, 255, 255]
  samples.sort((a, b) => luminance(a) - luminance(b))
  return samples[samples.length >> 1]
}

function groupBy<T>(items: T[], key: (item: T, index: number) => number): T[][] {
  const map = new Map<number, T[]>()
  items.forEach((item, i) => {
    const k = key(item, i)
    const list = map.get(k)
    if (list) list.push(item)
    else map.set(k, [item])
  })
  return [...map.values()]
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

function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
}

function weightedMedian(values: number[], weights: number[]): number {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  const total = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  for (const i of order) {
    acc += weights[i]
    if (acc >= total / 2) return values[i]
  }
  return 0
}

function luminance(c: number[]): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

/** Per-channel median. */
function medianRgb(samples: RGB[]): RGB {
  if (!samples.length) return [255, 255, 255]
  return [0, 1, 2].map((k) => quantile(samples.map((s) => s[k]), 0.5)) as RGB
}

function colorDistance(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

function toHex(c: RGB): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Letter height guessed from the model's box: from the line count when the model kept the line breaks,
 * from the box area per character (about 0.7 h wide, 1.3 h line pitch) otherwise.
 */
function estimateLetter(block: TextBlock): number {
  const tb = block.textBox
  const w = tb[2] - tb[0]
  const h = tb[3] - tb[1]
  const lines = Math.max(1, block.original.split('\n').length)
  const chars = Math.max(1, block.original.replace(/\s+/g, '').length)
  return lines > 1 ? h / lines / 1.25 : Math.min(h / 1.25, Math.sqrt((w * h) / (chars * 0.7 * 1.3)))
}

function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

function expand(b: Box, pad: number): Box {
  return expandXY(b, pad, pad)
}

function expandXY(b: Box, px: number, py: number): Box {
  return [b[0] - px, b[1] - py, b[2] + px, b[3] + py]
}

function roundBox(b: Box): Box {
  return [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])]
}

function clampBox(b: Box, w: number, h: number): Box {
  return [clamp(b[0], 0, w), clamp(b[1], 0, h), clamp(b[2], 0, w), clamp(b[3], 0, h)]
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
