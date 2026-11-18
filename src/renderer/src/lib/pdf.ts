import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { canvasToBlob, canvasToBytes } from './canvasBytes'
import { canvasToBytes } from './canvasBytes'

const assetBase = new URL('pdfjs/', window.location.href).href

/** Chromium refuses canvases taller than this. */
const MAX_CANVAS_SIDE = 32000
const MAX_CANVAS_PIXELS = 120_000_000

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js transfers (detaches) the buffer it receives, so hand it a copy.
  return pdfjs.getDocument({
    data: bytes.slice(),
    wasmUrl: `${assetBase}wasm/`,
    cMapUrl: `${assetBase}cmaps/`,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    iccUrl: `${assetBase}iccs/`
  }).promise
}

export interface RenderedPage {
  canvas: HTMLCanvasElement
  /** Page size in PDF points, used to rebuild the output PDF at the same physical size. */
  widthPt: number
  heightPt: number
}

/** Webtoon-style strips are far taller than wide and must be handled by width, not by longest side. */
export function isTallPage(widthPt: number, heightPt: number): boolean {
  return heightPt / widthPt > 2.2
}

export async function pageSize(doc: PDFDocumentProxy, pageNumber: number): Promise<{ widthPt: number; heightPt: number }> {
  const page = await doc.getPage(pageNumber)
  const { width, height } = page.getViewport({ scale: 1 })
  return { widthPt: width, heightPt: height }
}

/** Renders a 1-based page at `width` pixels wide (reduced if the result would exceed canvas limits). */
export async function renderPage(doc: PDFDocumentProxy, pageNumber: number, width: number): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(
    width / base.width,
    MAX_CANVAS_SIDE / base.height,
    Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height))
  )
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // The print intent makes pdf.js chain its steps with promises instead of animation frames,
  // which Windows stops delivering while the window is minimized or covered.
  await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise
  page.cleanup()

  return { canvas, widthPt: base.width, heightPt: base.height }
}

/** Copies a region of `source`, scaled so its longest side is at most `longSide`. */
export function cropCanvas(
  source: CanvasImageSource & { width: number; height: number },
  region: { x: number; y: number; width: number; height: number },
  longSide: number
): HTMLCanvasElement {
  const factor = Math.min(1, longSide / Math.max(region.width, region.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(region.width * factor))
  canvas.height = Math.max(1, Math.round(region.height * factor))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Top part of a page with a regular page aspect ratio, so webtoon strips get sensible thumbnails. */
export function thumbnailCanvas(source: CanvasImageSource & { width: number; height: number }, longSide: number): HTMLCanvasElement {
  const height = Math.min(source.height, Math.round(source.width / 0.7))
  return cropCanvas(source, { x: 0, y: 0, width: source.width, height }, longSide)
}

export async function canvasToBase64(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<string> {
  const bytes = await canvasToBytes(canvas, type, quality)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
