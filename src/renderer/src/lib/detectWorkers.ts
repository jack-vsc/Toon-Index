import { detectText, type TextRegion } from './detect'
import DetectWorker from './detect.worker?worker'
import { POOL_SIZE, workerPool } from './workerPool'

/**
 * Text detection is seconds of pixel work per page (a long webtoon strip, more): on the window's thread
 * it froze the whole app while chapters were translated. It runs on workers instead, the window only
 * reading the pixels out.
 */
const pool = workerPool(() => new DetectWorker(), POOL_SIZE)

/** detectText, off the window's thread; on it as before when a worker fails. */
export async function detectTextOff(canvas: HTMLCanvasElement): Promise<TextRegion[]> {
  const { width, height } = canvas
  if (width < 16 || height < 16) return []
  const pixels = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data
  try {
    return await pool.run<TextRegion[]>({ data: pixels, width, height }, [pixels.buffer])
  } catch (err) {
    console.warn('[detect] worker failed, detecting in the window:', err)
    return detectText(canvas)
  }
}
