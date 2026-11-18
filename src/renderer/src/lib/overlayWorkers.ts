import type { TextBlock } from '../../../shared/types'
import { drawOverlay, type OverlayInfo } from './overlay'
import OverlayWorker from './overlay.worker?worker'
import { inpaintCanvas, type Scene } from './scene'
import { POOL_SIZE, workerPool } from './workerPool'

/** A worker's request to run the inpainting model, which only the window reaches. */
async function inpaintFor(message: Record<string, unknown>, worker: Worker): Promise<void> {
  const image = message.image as ImageBitmap
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  image.close()
  const ok = await inpaintCanvas(canvas, message.mask as Uint8Array)
  const bitmap = ok ? await createImageBitmap(canvas) : null
  worker.postMessage({ inpainted: message.at, bitmap }, bitmap ? [bitmap] : [])
}

const pool = workerPool(
  () => new OverlayWorker(),
  POOL_SIZE,
  (message, worker) => message.request === 'inpaint' && void inpaintFor(message, worker)
)

/**
 * drawOverlay off the window's thread: the page goes to a worker and comes back lettered (taller when
 * footnotes were added). On the window as before when the worker fails.
 */
export async function drawOverlayOff(canvas: HTMLCanvasElement, blocks: TextBlock[], scene: Scene | null): Promise<OverlayInfo[]> {
  let out: { page: ImageBitmap; infos: OverlayInfo[] }
  try {
    const page = await createImageBitmap(canvas)
    out = await pool.run({ page, blocks, scene }, [page])
  } catch (err) {
    console.warn('[overlay] worker failed, drawing in the window:', err)
    return drawOverlay(canvas, blocks, scene)
  }
  canvas.width = out.page.width
  canvas.height = out.page.height
  canvas.getContext('2d')!.drawImage(out.page, 0, 0)
  out.page.close()
  return out.infos
}
