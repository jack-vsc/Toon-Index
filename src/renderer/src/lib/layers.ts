/**
 * A finished page kept as only what the translation changed on it: the erased and lettered parts, as
 * small WebP pieces over the page as rendered. Translating the same page again (the chapter deleted
 * and asked for once more) puts them back without the vision models or the AI: a few KB a page
 * instead of the whole picture.
 */

/** One translated page: its rendered size and the pieces that differ from the original. */
export interface PageLayer {
  width: number
  height: number
  blockCount: number
  patches: { x: number; y: number; webp: string }[]
}

/** Square cells compared between the page before and after; changed ones are joined into pieces. */
const CELL = 24
/** A channel this far from the original counts as changed (both come from the same render, so exact elsewhere). */
const TOLERANCE = 6
const WEBP_QUALITY = 0.9

/**
 * The page's identity: its pixels as rendered (a small copy, so it is quick), plus what decides the
 * translation drawn on it (the language, whether sound effects are translated).
 */
export async function layerKey(canvas: HTMLCanvasElement, tag: string): Promise<string> {
  const small = document.createElement('canvas')
  small.width = 256
  small.height = Math.max(1, Math.round((canvas.height / canvas.width) * 256))
  const ctx = small.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, small.width, small.height)
  const pixels = ctx.getImageData(0, 0, small.width, small.height).data
  const head = new TextEncoder().encode(`${tag}|${canvas.width}x${canvas.height}|`)
  const all = new Uint8Array(head.length + pixels.length)
  all.set(head)
  all.set(pixels, head.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The pieces of `after` that differ from `before` (same size), compared band by band to keep memory low. */
export async function extractLayer(before: HTMLCanvasElement, after: HTMLCanvasElement, blockCount: number): Promise<PageLayer> {
  const { width, height } = after
  const cols = Math.ceil(width / CELL)
  const rows = Math.ceil(height / CELL)
  const changed = new Uint8Array(cols * rows)
  const a = before.getContext('2d', { willReadFrequently: true })!
  const b = after.getContext('2d', { willReadFrequently: true })!
  const band = CELL * 40
  for (let top = 0; top < height; top += band) {
    const h = Math.min(band, height - top)
    const pa = a.getImageData(0, top, width, h).data
    const pb = b.getImageData(0, top, width, h).data
    for (let y = 0; y < h; y++) {
      const row = Math.floor((top + y) / CELL)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        if (
          Math.abs(pa[i] - pb[i]) > TOLERANCE ||
          Math.abs(pa[i + 1] - pb[i + 1]) > TOLERANCE ||
          Math.abs(pa[i + 2] - pb[i + 2]) > TOLERANCE
        ) {
          changed[row * cols + Math.floor(x / CELL)] = 1
          // The rest of this cell's row adds nothing.
          x = (Math.floor(x / CELL) + 1) * CELL - 1
        }
      }
    }
  }

  // Changed cells touching each other (corners too) make one piece, cut as the box around them.
  const seen = new Uint8Array(cols * rows)
  const patches: PageLayer['patches'] = []
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue
    let [x0, y0, x1, y1] = [start % cols, Math.floor(start / cols), start % cols, Math.floor(start / cols)]
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const cell = stack.pop()!
      const cx = cell % cols
      const cy = Math.floor(cell / cols)
      x0 = Math.min(x0, cx)
      x1 = Math.max(x1, cx)
      y0 = Math.min(y0, cy)
      y1 = Math.max(y1, cy)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const next = ny * cols + nx
          if (changed[next] && !seen[next]) {
            seen[next] = 1
            stack.push(next)
          }
        }
      }
    }
    const x = x0 * CELL
    const y = y0 * CELL
    const piece = document.createElement('canvas')
    piece.width = Math.min(width, (x1 + 1) * CELL) - x
    piece.height = Math.min(height, (y1 + 1) * CELL) - y
    piece.getContext('2d')!.drawImage(after, x, y, piece.width, piece.height, 0, 0, piece.width, piece.height)
    patches.push({ x, y, webp: await toBase64(piece) })
  }
  return { width, height, blockCount, patches }
}

/** Puts the saved pieces over the page as rendered; false when the layer is for another size. */
export async function applyLayer(canvas: HTMLCanvasElement, layer: PageLayer): Promise<boolean> {
  if (layer.width !== canvas.width || layer.height !== canvas.height) return false
  const ctx = canvas.getContext('2d')!
  for (const patch of layer.patches) {
    const bytes = Uint8Array.from(atob(patch.webp), (c) => c.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }))
    ctx.drawImage(image, patch.x, patch.y)
    image.close()
  }
  return true
}

async function toBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('WebP'))), 'image/webp', WEBP_QUALITY)
  )
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
