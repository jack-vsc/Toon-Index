import type { Box, VisionBlock } from '../../../shared/types'
import type { TextRegion } from './detect'
import { dilate, erode, odd } from './glyphs'
import { canvasToBytes } from './pdf'

/** A speech bubble's interior, rasterized over its bounding box. */
export interface Bubble {
  box: Box
  w: number
  h: number
  /** 1 = inside the bubble, in box coordinates. */
  mask: Uint8Array
  area: number
  /** A system window or caption box rather than a speech bubble. */
  frame: boolean
}

/** What the vision models found on a page, in canvas pixels. */
export interface Scene {
  width: number
  height: number
  blocks: VisionBlock[]
  bubbles: Bubble[]
  /** 1 = lettering, W×H. */
  textMask: Uint8Array
}

/** Runs the vision models on the page; null when the vision server is not available. */
export async function analyzePage(canvas: HTMLCanvasElement): Promise<Scene | null> {
  try {
    const res = await window.api.vision.detect(await canvasToBytes(canvas, 'image/png'))
    const textMask = await decodeMask(res.textMask, canvas.width, canvas.height)
    const bubbles = res.bubbles.map((b) => ({ ...rasterize(b.polygon, b.box), frame: b.frame }))
    return { width: canvas.width, height: canvas.height, blocks: res.blocks, bubbles, textMask }
  } catch (err) {
    console.warn('[vision] detection unavailable, using the built-in detector:', err)
    return null
  }
}

/**
 * Text blocks lying in the page rows y0..y1, in the coordinates of that slice's image (scaled down by
 * `scale`). Blocks cut by the slice edge are left to the neighbouring slice, unless `cut`.
 */
export function regionsInSlice(scene: Scene, y0: number, y1: number, scale: number, cut = false): TextRegion[] {
  return scene.blocks
    .filter((b) => (cut ? b.box[3] > y0 && b.box[1] < y1 : b.box[1] >= y0 && b.box[3] <= y1))
    .map((b) => ({
      box: [b.box[0] / scale, (b.box[1] - y0) / scale, b.box[2] / scale, (b.box[3] - y0) / scale] as Box,
      letterHeight: b.letterHeight / scale,
      glyphs: b.glyphs
    }))
}

/**
 * The bubble holding `box`: a detected outline that only covers part of the text is not its bubble,
 * though a window may leave out a sound effect on its border that shares the text's box.
 */
export function bubbleAt(scene: Scene, box: Box): Bubble | null {
  const area = Math.max(1, (box[2] - box[0]) * (box[3] - box[1]))
  let best: Bubble | null = null
  let bestInside = 0
  for (const b of scene.bubbles) {
    const inside = insideCount(b, box)
    if (inside > bestInside) (best = b), (bestInside = inside)
  }
  if (!best) return null
  const cx = Math.round((box[0] + box[2]) / 2 - best.box[0])
  const cy = Math.round((box[1] + box[3]) / 2 - best.box[1])
  const centred = cx >= 0 && cy >= 0 && cx < best.w && cy < best.h && best.mask[cy * best.w + cx] === 1
  return bestInside >= area * 0.85 || (centred && bestInside >= area * 0.6) ? best : null
}

/** Pixels of `box` inside the bubble. */
export function insideCount(b: Bubble, box: Box): number {
  const x0 = Math.max(0, Math.floor(box[0] - b.box[0]))
  const y0 = Math.max(0, Math.floor(box[1] - b.box[1]))
  const x1 = Math.min(b.w, Math.ceil(box[2] - b.box[0]))
  const y1 = Math.min(b.h, Math.ceil(box[3] - b.box[1]))
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += b.mask[y * b.w + x]
  return n
}

/**
 * Pixels to repaint for one block: the lettering the models and the glyph search found, grown over its
 * anti-aliased edges, and inside a bubble also its whole text area (the bubble's border kept).
 */
export function addEraseArea(
  out: Uint8Array,
  scene: Scene,
  box: Box,
  letterHeight: number,
  glyphs: { win: Box; ww: number; wh: number; mask: Uint8Array } | null
): void {
  const W = scene.width
  const H = scene.height
  const bubble = bubbleAt(scene, box)
  // Inside a bubble the whole area goes, generously: only the bubble's flat interior is repainted.
  const pad = Math.max(4, Math.round(letterHeight * (bubble ? 0.8 : 0.4)))
  const r = clampBox([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], W, H)
  if (bubble) {
    const k = odd(Math.max(3, Math.round(letterHeight * 0.25)))
    const inner = erode(bubble.mask, bubble.w, bubble.h, k)
    for (let y = r[1]; y < r[3]; y++) {
      for (let x = r[0]; x < r[2]; x++) {
        const bx = x - bubble.box[0]
        const by = y - bubble.box[1]
        if (bx >= 0 && by >= 0 && bx < bubble.w && by < bubble.h && inner[by * bubble.w + bx]) out[y * W + x] = 1
      }
    }
  }
  const rw = r[2] - r[0]
  const rh = r[3] - r[1]
  if (rw <= 0 || rh <= 0) return
  const local = new Uint8Array(rw * rh)
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) local[y * rw + x] = scene.textMask[(y + r[1]) * W + x + r[0]]
  if (glyphs) {
    const { win, ww, wh, mask } = glyphs
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const lx = x + win[0] - r[0]
        const ly = y + win[1] - r[1]
        if (mask[y * ww + x] && lx >= 0 && ly >= 0 && lx < rw && ly < rh) local[ly * rw + lx] = 1
      }
    }
  }
  const grown = dilate(local, rw, rh, odd(Math.max(5, Math.round(letterHeight * 0.45))))
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (grown[y * rw + x]) out[(y + r[1]) * W + x + r[0]] = 1
}

/** Repaints the masked pixels of the canvas with LaMa. Returns false when the vision server failed. */
export async function inpaintCanvas(canvas: HTMLCanvasElement, mask: Uint8Array): Promise<boolean> {
  try {
    const W = canvas.width
    const H = canvas.height
    const m = document.createElement('canvas')
    m.width = W
    m.height = H
    const mctx = m.getContext('2d')!
    const img = mctx.createImageData(W, H)
    for (let p = 0; p < mask.length; p++) {
      const v = mask[p] ? 255 : 0
      img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v
      img.data[p * 4 + 3] = 255
    }
    mctx.putImageData(img, 0, 0)
    const out = await window.api.vision.inpaint(await canvasToBytes(canvas, 'image/png'), await canvasToBytes(m, 'image/png'))
    const bitmap = await createImageBitmap(new Blob([out as BlobPart], { type: 'image/png' }))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()
    return true
  } catch (err) {
    console.warn('[vision] inpainting failed, using the built-in fill:', err)
    return false
  }
}

async function decodeMask(png: Uint8Array, W: number, H: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, W, H)
  bitmap.close()
  const d = ctx.getImageData(0, 0, W, H).data
  const mask = new Uint8Array(W * H)
  for (let p = 0; p < mask.length; p++) mask[p] = d[p * 4] > 127 ? 1 : 0
  return mask
}

function rasterize(polygon: [number, number][], box: Box): Omit<Bubble, 'frame'> {
  const w = Math.max(1, box[2] - box[0])
  const h = Math.max(1, box[3] - box[1])
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.beginPath()
  polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x - box[0], y - box[1]) : ctx.moveTo(x - box[0], y - box[1])))
  ctx.closePath()
  ctx.fill()
  const d = ctx.getImageData(0, 0, w, h).data
  const mask = new Uint8Array(w * h)
  let area = 0
  for (let p = 0; p < mask.length; p++) if (d[p * 4 + 3] > 127) (mask[p] = 1), area++
  return { box, w, h, mask, area }
}

function clampBox(b: Box, W: number, H: number): Box {
  return [Math.max(0, Math.round(b[0])), Math.max(0, Math.round(b[1])), Math.min(W, Math.round(b[2])), Math.min(H, Math.round(b[3]))]
}

/** A sound effect drawn over the artwork: its lettering's pixels over `box` (1 = lettering). */
export interface SfxShape {
  box: Box
  w: number
  h: number
  mask: Uint8Array
  /** Share of the box the lettering covers. */
  coverage: number
}

/** The lettering of a sound effect in `box`: what the models mark as text, and what the glyph search found. */
export function sfxShape(scene: Scene, box: Box, glyphs: { win: Box; ww: number; wh: number; mask: Uint8Array } | null): SfxShape {
  const r = clampBox(box, scene.width, scene.height)
  const w = Math.max(1, r[2] - r[0])
  const h = Math.max(1, r[3] - r[1])
  const mask = new Uint8Array(w * h)
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x + r[0] - (glyphs?.win[0] ?? 0)
      const gy = y + r[1] - (glyphs?.win[1] ?? 0)
      const glyph = glyphs !== null && gx >= 0 && gy >= 0 && gx < glyphs.ww && gy < glyphs.wh && glyphs.mask[gy * glyphs.ww + gx] === 1
      if (scene.textMask[(y + r[1]) * scene.width + x + r[0]] || glyph) (mask[y * w + x] = 1), n++
    }
  }
  return { box: r, w, h, mask, coverage: n / (w * h) }
}

/**
 * Share of its box a sound effect's strokes must cover for it to be redrawn: below it the vision models
 * see little lettering there, and the translation model may have read a face or a pattern as one.
 * Chapter 53: real effects cover 18-68% of their box, a face taken for one 10%.
 */
export const SFX_MIN_COVERAGE = 0.15

/** Pixels to repaint for a sound effect: its strokes, grown over their outline. */
export function addSfxEraseArea(out: Uint8Array, scene: Scene, shape: SfxShape): void {
  const { box, w, h } = shape
  const grown = dilate(shape.mask, w, h, odd(Math.max(7, Math.round(Math.min(w, h) * 0.12))))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (grown[y * w + x]) out[(y + box[1]) * scene.width + x + box[0]] = 1
  }
}
