/** Canvases that work in the window and in a worker (overlay.worker.ts), where there is no document. */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export function newCanvas(width: number, height: number): AnyCanvas {
  if (typeof document === 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

export function ctx2d(canvas: AnyCanvas, willReadFrequently = false): Ctx2D {
  return (canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently })!
}
