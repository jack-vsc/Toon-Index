/** Pixel primitives shared by text detection and the overlay: morphology, components, glyph tests. */

/** Max grey-level distance for a glyph's surroundings to count as flat background. */
const FLAT_TOLERANCE = 28

export interface Comp {
  id: number
  x0: number
  y0: number
  x1: number
  y1: number
  w: number
  h: number
  count: number
}

/**
 * A glyph sits on flat background (most non-ink pixels around it share one grey level) and clearly
 * differs from it. Artwork fails the first test; the background gaps between letters fail the second.
 */
export function isGlyph(
  c: Comp,
  gray: Uint8Array,
  ink: Uint8Array,
  labels: Int32Array,
  ww: number,
  wh: number,
  tolerance = FLAT_TOLERANCE
): boolean {
  const e = Math.max(2, Math.round(c.h * 0.35))
  const x0 = Math.max(0, c.x0 - e)
  const y0 = Math.max(0, c.y0 - e)
  const x1 = Math.min(ww, c.x1 + e)
  const y1 = Math.min(wh, c.y1 + e)
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 300)))
  const around: number[] = []
  let own = 0
  let ownCount = 0
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = y * ww + x
      if (!ink[p]) around.push(gray[p])
      else if (labels[p] === c.id) (own += gray[p]), ownCount++
    }
  }
  if (around.length < 8) return false
  const median = quantile(around, 0.5)
  let flat = 0
  for (const v of around) if (Math.abs(v - median) <= tolerance) flat++
  if (flat / around.length < 0.6) return false
  return ownCount === 0 || Math.abs(own / ownCount - median) >= 50
}

/** 8-connected components of a binary mask. */
export function components(mask: Uint8Array, ww: number, wh: number): { labels: Int32Array; comps: Comp[] } {
  const labels = new Int32Array(ww * wh)
  const stack = new Int32Array(ww * wh)
  const comps: Comp[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    const id = comps.length + 1
    let x0 = ww
    let y0 = wh
    let x1 = 0
    let y1 = 0
    let count = 0
    let sp = 0
    stack[sp++] = start
    labels[start] = id
    while (sp) {
      const p = stack[--sp]
      const x = p % ww
      const y = (p - x) / ww
      count++
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x >= x1) x1 = x + 1
      if (y >= y1) y1 = y + 1
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= wh) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= ww) continue
          const q = ny * ww + nx
          if (mask[q] && !labels[q]) {
            labels[q] = id
            stack[sp++] = q
          }
        }
      }
    }
    comps.push({ id, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, count })
  }
  return { labels, comps }
}

export function dilate(src: Uint8Array, ww: number, wh: number, k: number): Uint8Array {
  return morph(src, ww, wh, k, true)
}

export function erode(src: Uint8Array, ww: number, wh: number, k: number): Uint8Array {
  return morph(src, ww, wh, k, false)
}

/** Square max (or min) filter of side k, separable, van Herk / Gil-Werman: O(1) per pixel. */
function morph(src: Uint8Array, ww: number, wh: number, k: number, max: boolean): Uint8Array {
  const r = k >> 1
  const size = Math.max(ww, wh) + 2 * r
  const line = new Uint8Array(size)
  const g = new Uint8Array(size)
  const h = new Uint8Array(size)
  const tmp = new Uint8Array(ww * wh)
  const out = new Uint8Array(ww * wh)

  const run = (n: number, read: (i: number) => number, write: (i: number, v: number) => void) => {
    const m = n + 2 * r
    for (let i = 0; i < m; i++) line[i] = read(Math.min(n - 1, Math.max(0, i - r)))
    for (let i = 0; i < m; i++) {
      const v = line[i]
      g[i] = i % k === 0 ? v : max ? (v > g[i - 1] ? v : g[i - 1]) : v < g[i - 1] ? v : g[i - 1]
    }
    for (let i = m - 1; i >= 0; i--) {
      const v = line[i]
      h[i] = i === m - 1 || (i + 1) % k === 0 ? v : max ? (v > h[i + 1] ? v : h[i + 1]) : v < h[i + 1] ? v : h[i + 1]
    }
    for (let i = 0; i < n; i++) {
      const a = h[i]
      const b = g[i + 2 * r]
      write(i, max ? (a > b ? a : b) : a < b ? a : b)
    }
  }

  for (let y = 0; y < wh; y++) {
    const row = y * ww
    run(ww, (i) => src[row + i], (i, v) => (tmp[row + i] = v))
  }
  for (let x = 0; x < ww; x++) {
    run(wh, (i) => tmp[i * ww + x], (i, v) => (out[i * ww + x] = v))
  }
  return out
}

export function quantile(values: number[], q: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

export function odd(n: number): number {
  return n % 2 ? n : n + 1
}
