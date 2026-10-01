export interface Slice {
  y0: number
  y1: number
}

const SAMPLE_WIDTH = 200
/** A row is a gutter when almost none of its pixels differ from the row's dominant tone. */
const BLANK_ROW_BUSYNESS = 0.01

/**
 * Splits a tall page into slices of roughly `sliceHeight` px. Cuts are placed on blank rows
 * (the gutters between webtoon panels) when possible, so no speech bubble is split; when no
 * gutter is found the slices overlap by `overlap` px instead.
 */
export function planSlices(canvas: HTMLCanvasElement, sliceHeight: number, overlap: number): Slice[] {
  const height = canvas.height
  if (height <= sliceHeight * 1.15) return [{ y0: 0, y1: height }]

  const busy = rowBusyness(canvas)
  const ratio = height / busy.length
  const isBlank = (y: number) => busy[Math.min(busy.length - 1, Math.floor(y / ratio))] < BLANK_ROW_BUSYNESS

  const slices: Slice[] = []
  let start = 0
  while (height - start > sliceHeight * 1.15) {
    const target = start + sliceHeight
    const earliest = start + sliceHeight * 0.55
    let cut: number | undefined
    for (let y = target; y >= earliest; y -= ratio) {
      if (isBlank(y)) {
        cut = Math.round(y)
        break
      }
    }
    if (cut !== undefined) {
      slices.push({ y0: start, y1: cut })
      start = cut
    } else {
      slices.push({ y0: start, y1: target })
      start = target - overlap
    }
  }
  slices.push({ y0: start, y1: height })
  return slices
}

/** Fraction of "non-background" pixels per row, computed on a downscaled greyscale copy. */
function rowBusyness(canvas: HTMLCanvasElement): Float32Array {
  const w = Math.min(SAMPLE_WIDTH, canvas.width)
  const h = Math.max(1, Math.round((canvas.height * w) / canvas.width))
  const small = document.createElement('canvas')
  small.width = w
  small.height = h
  const ctx = small.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(canvas, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data

  const result = new Float32Array(h)
  const row = new Uint8Array(w)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      row[x] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
    }
    const median = [...row].sort((a, b) => a - b)[w >> 1]
    let differing = 0
    for (let x = 0; x < w; x++) if (Math.abs(row[x] - median) > 24) differing++
    result[y] = differing / w
  }
  return result
}
