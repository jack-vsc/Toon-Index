import type { PDFDocumentProxy } from 'pdfjs-dist'
import { FATAL_ERRORS, toAppError, type AppError } from '../../../shared/errors'
import { CANCELLED, type Box, type MarkedRegion, type PageImage, type TextBlock } from '../../../shared/types'
import { detectText, drawKey, drawMarks, type TextRegion } from './detect'
import { buildPdf, type OutputPage } from './exportPdf'
import { ensureFonts } from './fonts'
import { drawOverlay, type OverlayInfo } from './overlay'
import {
  canvasToBase64,
  canvasToBlob,
  canvasToBytes,
  cropCanvas,
  isTallPage,
  loadPdf,
  pageSize,
  renderPage,
  thumbnailCanvas
} from './pdf'
import { planSlices } from './slicing'
import { normalizeText, similarText } from './text'

/** Output resolution (page width in px). */
const OUTPUT_WIDTH = 1400
const OUTPUT_WIDTH_TALL = 1000
/** Longest side of each image sent to the model; vision models downscale beyond ~1568px anyway. */
const AI_LONG_SIDE = 1568
const AI_LONG_SIDE_TALL = 1280
/** Slices of a tall page are about this many times taller than wide. */
const SLICE_ASPECT = 1.6
const SLICE_OVERLAP = 0.45
const MAX_IMAGES_PER_REQUEST = 6
const THUMB_LONG_SIDE = 360

export type PageStatus = 'pending' | 'working' | 'done' | 'error' | 'skipped'

export interface PageState {
  number: number
  status: PageStatus
  /** height / width, so readers can reserve space before the image exists. */
  aspect: number
  tall: boolean
  error?: AppError
  blockCount?: number
  thumbUrl?: string
  /** Full-size output image (translated, or original for skipped pages). */
  imageUrl?: string
  parts?: { done: number; total: number }
  ms?: number
}

export class TranslationJob {
  pages: PageState[] = []
  /** Set when the last run stopped by itself because every remaining page would fail the same way. */
  stopReason: AppError | null = null
  /** Blocks found on each translated page, in page pixel coordinates. */
  readonly blocks = new Map<number, TextBlock[]>()
  /** Evaluation runs inspect each page before and after the translation is drawn, with the detected text. */
  onPageRendered?: (pageNumber: number, before: HTMLCanvasElement, after: HTMLCanvasElement, regions: Box[], drawn: OverlayInfo[]) => Promise<void>
  private outputs = new Map<number, OutputPage>()
  private cancelled = false
  private activeRequests = new Set<string>()
  private limiter = new Limiter(1)

  private constructor(
    readonly doc: PDFDocumentProxy,
    private onChange: (pages: PageState[]) => void
  ) {}

  static async open(bytes: Uint8Array, onChange: (pages: PageState[]) => void): Promise<TranslationJob> {
    return new TranslationJob(await loadPdf(bytes), onChange)
  }

  get numPages(): number {
    return this.doc.numPages
  }

  /**
   * Restricts the job (and the output PDF) to `pageNumbers`; those listed in `untranslated` are kept
   * in the output as they are.
   */
  async select(pageNumbers: number[], untranslated: number[] = []): Promise<void> {
    this.clearUrls()
    this.outputs.clear()
    this.blocks.clear()
    const skip = new Set(untranslated)
    this.pages = await Promise.all(
      pageNumbers.map(async (number): Promise<PageState> => {
        const { widthPt, heightPt } = await pageSize(this.doc, number)
        return { number, status: skip.has(number) ? 'skipped' : 'pending', aspect: heightPt / widthPt, tall: isTallPage(widthPt, heightPt) }
      })
    )
    this.onChange(this.pages)
    for (const page of this.pages) {
      if (page.status !== 'skipped') continue
      const output = await this.renderOriginal(page.number)
      this.outputs.set(page.number, output)
      this.update(page.number, { imageUrl: jpegUrl(output.jpeg) })
    }
  }

  /** Translates every selected page that is not done yet. */
  async run(concurrency: number): Promise<void> {
    this.cancelled = false
    this.stopReason = null
    this.limiter = new Limiter(concurrency)
    this.retry()
    // Pages are picked when a worker is free, so pages retried during the run join it.
    const claimed = new Set<number>()
    const worker = async () => {
      while (!this.cancelled) {
        const next = this.pages.find((p) => p.status === 'pending' && !claimed.has(p.number))
        if (!next) return
        claimed.add(next.number)
        await this.processPage(next.number)
        claimed.delete(next.number)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  }

  /** Puts failed pages (the given ones, or all) back in the queue. */
  retry(pageNumbers?: number[]): void {
    for (const page of this.pages) {
      if (page.status === 'error' && (!pageNumbers || pageNumbers.includes(page.number))) {
        this.update(page.number, { status: 'pending', error: undefined })
      }
    }
  }

  /** Stops right away: running model requests are aborted and their pages go back to the queue. */
  cancel(): void {
    this.cancelled = true
    if (this.activeRequests.size) void window.api.cancelTranslations([...this.activeRequests])
  }

  get failedPages(): number[] {
    return this.pages.filter((p) => p.status === 'error').map((p) => p.number)
  }

  get translatedCount(): number {
    return this.pages.filter((p) => p.status === 'done').length
  }

  /** Pages that failed or were never translated keep their original image. */
  async buildPdf(title: string): Promise<{ pdf: Uint8Array; cover: Uint8Array }> {
    const pages: OutputPage[] = []
    for (const { number } of this.pages) {
      pages.push(this.outputs.get(number) ?? (await this.renderOriginal(number)))
    }
    const first = await createImageBitmap(new Blob([pages[0].jpeg as BlobPart], { type: 'image/jpeg' }))
    const cover = await canvasToBytes(thumbnailCanvas(first, 480), 'image/jpeg', 0.85)
    first.close()
    return { pdf: await buildPdf(pages, title), cover }
  }

  dispose(): void {
    this.cancel()
    this.clearUrls()
    void this.doc.loadingTask.destroy()
  }

  private clearUrls(): void {
    for (const page of this.pages) {
      if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl)
      if (page.imageUrl) URL.revokeObjectURL(page.imageUrl)
    }
  }

  private async processPage(pageNumber: number): Promise<void> {
    const started = performance.now()
    this.update(pageNumber, { status: 'working', error: undefined, parts: undefined })
    try {
      const { widthPt, heightPt } = await pageSize(this.doc, pageNumber)
      const tall = isTallPage(widthPt, heightPt)
      const canvas = await renderForTranslation(this.doc, pageNumber)
      const prepared = prepareSlices(canvas, tall)

      const chunks = chunk(prepared, MAX_IMAGES_PER_REQUEST)
      let done = 0
      this.update(pageNumber, { parts: { done, total: chunks.length } })
      const results = await Promise.all(
        chunks.map((part) =>
          this.limiter.run(async () => {
            if (this.cancelled) throw new Error(CANCELLED)
            const { images, key, regions } = await markedImages(part)
            const requestId = crypto.randomUUID()
            this.activeRequests.add(requestId)
            try {
              const blocks = await window.api.translate({ images, key, regions, pageNumber, requestId })
              this.update(pageNumber, { parts: { done: ++done, total: chunks.length } })
              return blocks.flatMap((list, i) => list.map((b) => toPageSpace(b, part[i].scale, part[i].offsetY)))
            } finally {
              this.activeRequests.delete(requestId)
            }
          })
        )
      )
      if (this.cancelled) throw new Error(CANCELLED)

      const blocks = dedupe(results.flat())
      this.blocks.set(pageNumber, blocks)
      await ensureFonts()
      const pagePx = canvas.height
      const before = this.onPageRendered ? cropCanvas(canvas, { x: 0, y: 0, width: canvas.width, height: pagePx }, Infinity) : null
      const drawn = drawOverlay(canvas, blocks)
      const heightPtOut = heightPt * (canvas.height / pagePx)
      if (before) {
        const regions = prepared.flatMap((p) =>
          p.regions.map(({ box: b }): Box => [b[0] * p.scale, b[1] * p.scale + p.offsetY, b[2] * p.scale, b[3] * p.scale + p.offsetY])
        )
        await this.onPageRendered?.(pageNumber, before, canvas, regions, drawn)
      }

      const jpeg = await canvasToBytes(canvas, 'image/jpeg', 0.9)
      this.outputs.set(pageNumber, { jpeg, widthPt, heightPt: heightPtOut })
      this.update(pageNumber, {
        status: 'done',
        blockCount: blocks.length,
        ms: performance.now() - started,
        imageUrl: jpegUrl(jpeg),
        thumbUrl: URL.createObjectURL(await canvasToBlob(thumbnailCanvas(canvas, THUMB_LONG_SIDE), 'image/jpeg', 0.8))
      })
    } catch (err) {
      if (this.cancelled) {
        this.update(pageNumber, { status: 'pending', parts: undefined })
        return
      }
      const error = toAppError(err)
      this.update(pageNumber, { status: 'error', error })
      if (FATAL_ERRORS.has(error.code)) {
        this.stopReason = error
        this.cancel()
      }
    }
  }

  private async renderOriginal(pageNumber: number): Promise<OutputPage> {
    const { widthPt, heightPt } = await pageSize(this.doc, pageNumber)
    const rendered = await renderPage(this.doc, pageNumber, isTallPage(widthPt, heightPt) ? OUTPUT_WIDTH_TALL : OUTPUT_WIDTH)
    return { jpeg: await canvasToBytes(rendered.canvas, 'image/jpeg', 0.9), widthPt, heightPt }
  }

  private update(pageNumber: number, patch: Partial<PageState>): void {
    const old = this.pages.find((p) => p.number === pageNumber)
    if (patch.thumbUrl && old?.thumbUrl) URL.revokeObjectURL(old.thumbUrl)
    if (patch.imageUrl && old?.imageUrl) URL.revokeObjectURL(old.imageUrl)
    this.pages = this.pages.map((p) => (p.number === pageNumber ? { ...p, ...patch } : p))
    this.onChange(this.pages)
  }
}

class Limiter {
  private active = 0
  private waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export interface PreparedSlice {
  crop: HTMLCanvasElement
  regions: TextRegion[]
  offsetY: number
  scale: number
}

export async function renderForTranslation(doc: PDFDocumentProxy, pageNumber: number): Promise<HTMLCanvasElement> {
  const { widthPt, heightPt } = await pageSize(doc, pageNumber)
  return (await renderPage(doc, pageNumber, isTallPage(widthPt, heightPt) ? OUTPUT_WIDTH_TALL : OUTPUT_WIDTH)).canvas
}

/** Cuts the page into the overlapping images sent to the model and finds the text on each. */
export function prepareSlices(canvas: HTMLCanvasElement, tall: boolean): PreparedSlice[] {
  const sliceHeight = Math.round(canvas.width * SLICE_ASPECT)
  const slices = planSlices(canvas, sliceHeight, Math.round(sliceHeight * SLICE_OVERLAP))
  const aiLongSide = tall ? AI_LONG_SIDE_TALL : AI_LONG_SIDE
  const prepared = slices.map((slice) => {
    const crop = cropCanvas(canvas, { x: 0, y: slice.y0, width: canvas.width, height: slice.y1 - slice.y0 }, aiLongSide)
    // Text touching a cut between overlapping slices is whole in the neighbouring slice.
    const cutTop = slice.y0 > 0
    const cutBottom = slice.y1 < canvas.height
    const regions = detectText(crop).filter((r) => !(cutTop && r.box[1] <= 2) && !(cutBottom && r.box[3] >= crop.height - 2))
    return { crop, regions, offsetY: slice.y0, scale: canvas.width / crop.width }
  })
  boxOnce(prepared)
  return prepared
}

/**
 * Text in the overlap of two slices is detected in both, sometimes cut short in one. Each text keeps
 * only its most complete box (the largest, away from the cut), so the model reads it once and whole.
 */
function boxOnce(slices: PreparedSlice[]): void {
  const all = slices.flatMap((s, i) =>
    s.regions.map((r) => {
      const b = r.box
      const page: Box = [b[0] * s.scale, b[1] * s.scale + s.offsetY, b[2] * s.scale, b[3] * s.scale + s.offsetY]
      const margin = Math.min(b[1], s.crop.height - b[3])
      const area = (page[2] - page[0]) * (page[3] - page[1])
      return { slice: i, region: r, page, score: area * (margin >= r.letterHeight ? 1 : 0.5) }
    })
  )
  const dropped = new Set<TextRegion>()
  for (const a of all) {
    for (const b of all) {
      if (a.slice === b.slice || dropped.has(a.region) || dropped.has(b.region)) continue
      const ix = Math.min(a.page[2], b.page[2]) - Math.max(a.page[0], b.page[0])
      const iy = Math.min(a.page[3], b.page[3]) - Math.max(a.page[1], b.page[1])
      const smaller = Math.min((a.page[2] - a.page[0]) * (a.page[3] - a.page[1]), (b.page[2] - b.page[0]) * (b.page[3] - b.page[1]))
      if (ix > 0 && iy > 0 && ix * iy > 0.3 * smaller) dropped.add(a.score >= b.score ? b.region : a.region)
    }
  }
  for (const s of slices) s.regions = s.regions.filter((r) => !dropped.has(r))
}

/**
 * Numbers the detected regions across the request, draws them on the images sent to the model, and
 * draws the key: every region enlarged with its number.
 */
async function markedImages(
  part: { crop: HTMLCanvasElement; regions: TextRegion[] }[]
): Promise<{ images: PageImage[]; key: PageImage[]; regions: MarkedRegion[] }> {
  const regions: MarkedRegion[] = []
  const marks = part.map((p, image) =>
    p.regions.map((r) => {
      const region = { id: regions.length + 1, image, box: r.box, letterHeight: r.letterHeight, glyphs: r.glyphs }
      regions.push(region)
      return { ...region, source: p.crop }
    })
  )
  const encode = async (canvas: HTMLCanvasElement): Promise<PageImage> => ({
    base64: await canvasToBase64(canvas, 'image/jpeg', 0.85),
    mimeType: 'image/jpeg',
    width: canvas.width,
    height: canvas.height
  })
  const images = await Promise.all(part.map((p, i) => encode(drawMarks(p.crop, marks[i]))))
  const key = await Promise.all(drawKey(marks.flat()).map(encode))
  return { images, key, regions }
}

function jpegUrl(jpeg: Uint8Array): string {
  return URL.createObjectURL(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
}

function toPageSpace(block: TextBlock, scale: number, offsetY: number): TextBlock {
  const map = (b: Box): Box => [b[0] * scale, b[1] * scale + offsetY, b[2] * scale, b[3] * scale + offsetY]
  return {
    ...block,
    textBox: map(block.textBox),
    areaBox: map(block.areaBox),
    inkBoxes: block.inkBoxes?.map(map),
    letterHeight: block.letterHeight && block.letterHeight * scale
  }
}

/**
 * Overlapping slices report the same bubble twice, often with slightly different boxes and wording.
 * Copies are matched by box overlap or by similar text close by; the most complete copy is kept.
 */
export function dedupe(blocks: TextBlock[]): TextBlock[] {
  const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  // Blocks on detected text are placed exactly; a copy placed by the model's own box is not.
  const score = (b: TextBlock) => (b.inkBoxes ? 1e15 : 0) + normalizeText(b.original).length * 1e9 + area(b.textBox)
  const sorted = [...blocks].sort((a, b) => score(b) - score(a))
  const kept: TextBlock[] = []
  for (const block of sorted) {
    const duplicate = kept.some((k) => {
      const a = k.textBox
      const b = block.textBox
      const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
      const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
      if (ix > 0 && iy > 0 && (ix * iy) / Math.min(area(a), area(b)) > 0.5) return true
      // Box positions of the same bubble seen in two slices can differ by a couple of lines.
      const height = Math.max(a[3] - a[1], b[3] - b[1])
      const near = ix > 0 && iy > -2 * height
      return near && similarText(k.original, block.original)
    })
    if (!duplicate) kept.push(block)
  }
  return kept.sort((a, b) => a.textBox[1] - b.textBox[1])
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function cleanIpcError(err: unknown): string {
  return toAppError(err).message
}
