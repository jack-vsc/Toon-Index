import type { PDFDocumentProxy } from 'pdfjs-dist'
import { FATAL_ERRORS, toAppError, type AppError } from '../../../shared/errors'
import {
  CANCELLED,
  type Box,
  type MarkedRegion,
  type PageImage,
  type TextBlock
} from '../../../shared/types'
import { drawKey, drawMarks, type TextRegion } from './detect'
import { detectTextOff } from './detectWorkers'
import { buildPdf, type OutputPage } from './exportPdf'
import { applyLayer, extractLayer, layerKey, type PageLayer } from './layers'
import { ensureFonts } from './fonts'
import type { OverlayInfo } from './overlay'
import { drawOverlayOff } from './overlayWorkers'
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
import { analyzePage, regionsInSlice, type Scene } from './scene'
import { normalizeText, similarText } from './text'
import { buildFlow, buildNovelPdf, novelLayout, readNovelPage, type NovelFlow, type NovelParagraph, type NovelPiece } from './novel'

/** A novel's paragraphs go to the AI about this many characters at a time (a page or two of text). */
const NOVEL_BATCH_CHARS = 3500
const NOVEL_BATCH_PARAGRAPHS = 40

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
  /** What a working page is waiting for or doing, when pages go through the steps together (phased runs). */
  stage?: string
  ms?: number
}

/** A page after detection: what is kept between the steps of a phased run (the page is rendered again). */
interface Detected {
  started: number
  widthPt: number
  heightPt: number
  tall: boolean
  scene: Scene | null
}

export class TranslationJob {
  pages: PageState[] = []
  /** Set when the last run stopped by itself because every remaining page would fail the same way. */
  stopReason: AppError | null = null
  /** Blocks found on each translated page, in page pixel coordinates. */
  readonly blocks = new Map<number, TextBlock[]>()
  /** Evaluation runs inspect each page before and after the translation is drawn, with the detected text. */
  onPageRendered?: (pageNumber: number, before: HTMLCanvasElement, after: HTMLCanvasElement, regions: Box[], drawn: OverlayInfo[]) => Promise<void>
  /**
   * Finished pages kept as what changed on them (lib/layers), under the run's language and sound-effect
   * choice; `reuse` puts a page translated before back from it instead of asking the AI again.
   */
  layers: { tag: string; reuse: boolean } | null = null
  /** A novel: its text is read from the PDF, translated paragraph by paragraph and set again (lib/novel). */
  novel = false
  /** The chapter's name, kept with each page in the training dataset. */
  chapter = ''
  private novelPieces = new Map<number, NovelPiece[]>()
  private novelFlow: NovelFlow = []
  private novelText = new Map<number, string>()
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

  /**
   * Translates every selected page that is not done yet. `phased` runs one AI at a time on the GPU for
   * the whole chapter (detection, then translation, then erasing and lettering) instead of page by page,
   * so a local translation model gets the GPU to itself.
   */
  async run(concurrency: number, phased = false): Promise<void> {
    this.cancelled = false
    this.stopReason = null
    this.limiter = new Limiter(concurrency)
    this.retry()
    if (this.novel) return this.runNovel(concurrency)
    if (phased) return this.runPhased(concurrency)
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

  private async runPhased(concurrency: number): Promise<void> {
    const pending = this.pages.filter((p) => p.status === 'pending').map((p) => p.number)
    const detected = new Map<number, Detected>()
    for (const number of pending) {
      if (this.cancelled) break
      await this.guard(number, async () => {
        if (await this.fromLayer(number)) return
        const { started, widthPt, heightPt, tall, scene } = await this.detect(number, 'Detectando texto')
        detected.set(number, { started, widthPt, heightPt, tall, scene })
        this.update(number, { stage: 'Aguardando tradução' })
      })
    }
    // The vision models leave the GPU to the translation model.
    await window.api.ai.stop('vision').catch(() => undefined)
    const translated = new Map<number, TextBlock[]>()
    const queue = [...detected.keys()]
    const worker = async () => {
      for (let number = queue.shift(); number !== undefined && !this.cancelled; number = queue.shift()) {
        const page = detected.get(number)!
        await this.guard(number, async () => {
          this.update(number, { stage: 'Traduzindo' })
          const canvas = await renderForTranslation(this.doc, number)
          translated.set(number, await this.translateSlices(number, await prepareSlices(canvas, page.tall, page.scene)))
          this.update(number, { stage: 'Aguardando redesenho' })
        })
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
    // And the translation model leaves it to the inpainting model.
    if (!this.cancelled) await window.api.ai.stop('ollama-models').catch(() => undefined)
    for (const [number, blocks] of translated) {
      if (this.cancelled) break
      const page = detected.get(number)!
      await this.guard(number, async () => {
        this.update(number, { stage: 'Redesenhando' })
        const canvas = await renderForTranslation(this.doc, number)
        await this.draw(number, { ...page, canvas, prepared: await prepareSlices(canvas, page.tall, page.scene) }, blocks)
      })
    }
    for (const number of pending) if (!this.cancelled && this.pages.find((p) => p.number === number)?.status === 'working') this.update(number, { status: 'pending', stage: undefined })
  }

  /**
   * A novel: every page's text read first (no vision), joined into paragraphs, and those translated a
   * batch at a time. A page is done once every paragraph on it is; picture pages are done at once.
   */
  private async runNovel(concurrency: number): Promise<void> {
    for (const page of this.pages) {
      if (this.cancelled) return
      if (page.status !== 'pending' || this.novelPieces.has(page.number)) continue
      this.update(page.number, { status: 'working', stage: 'Lendo o texto', error: undefined })
      this.novelPieces.set(page.number, await readNovelPage(this.doc, page.number))
      this.update(page.number, { status: 'pending', stage: undefined })
    }
    this.novelFlow = buildFlow(this.pages.map((p) => (p.status === 'skipped' ? [{ kind: 'picture', page: p.number }] : this.novelPieces.get(p.number) ?? [])))
    const paragraphs = this.novelFlow.flatMap((piece) => (piece.kind === 'paragraph' ? [piece.paragraph] : []))
    // What each page still waits for; a page with nothing to translate (a picture) is done now.
    const waiting = new Map<number, number>()
    for (const p of paragraphs) if (!this.novelText.has(p.id)) for (const n of p.pages) waiting.set(n, (waiting.get(n) ?? 0) + 1)
    for (const page of this.pages) if (page.status === 'pending' && !waiting.has(page.number)) this.update(page.number, { status: 'done', stage: undefined })

    const batches: NovelParagraph[][] = []
    let batch: NovelParagraph[] = []
    let size = 0
    for (const p of paragraphs) {
      if (this.novelText.has(p.id) || !p.pages.some((n) => this.pages.find((pg) => pg.number === n)?.status === 'pending')) continue
      if (batch.length && (size + p.text.length > NOVEL_BATCH_CHARS || batch.length >= NOVEL_BATCH_PARAGRAPHS)) {
        batches.push(batch)
        batch = []
        size = 0
      }
      batch.push(p)
      size += p.text.length
    }
    if (batch.length) batches.push(batch)

    const worker = async () => {
      for (let next = batches.shift(); next && !this.cancelled; next = batches.shift()) {
        const pages = [...new Set(next.flatMap((p) => p.pages))]
        for (const n of pages) this.update(n, { status: 'working', stage: 'Traduzindo', error: undefined })
        try {
          const translated = await this.translateParagraphs(next, paragraphs)
          next.forEach((p, i) => this.novelText.set(p.id, translated[i]))
          for (const p of next) for (const n of p.pages) waiting.set(n, (waiting.get(n) ?? 1) - 1)
          for (const n of pages) this.update(n, waiting.get(n)! <= 0 ? { status: 'done', stage: undefined } : { status: 'pending', stage: undefined })
        } catch (err) {
          if (this.cancelled) {
            for (const n of pages) this.update(n, { status: 'pending', stage: undefined })
            return
          }
          const error = toAppError(err)
          for (const n of pages) this.update(n, { status: 'error', error, stage: undefined })
          if (FATAL_ERRORS.has(error.code)) {
            this.stopReason = error
            this.cancel()
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  }

  /** A batch of paragraphs; when the AI loses count of them, the batch is sent again in halves. */
  private async translateParagraphs(batch: NovelParagraph[], all: NovelParagraph[]): Promise<string[]> {
    const requestId = `novel-${batch[0].id}-${Math.random().toString(36).slice(2)}`
    this.activeRequests.add(requestId)
    const start = all.indexOf(batch[0])
    try {
      return await window.api.translateText({
        paragraphs: batch.map((p) => p.text),
        context: all.slice(Math.max(0, start - 2), start).map((p) => p.text),
        pageNumber: batch[0].pages[0],
        requestId
      })
    } catch (err) {
      if (this.cancelled || batch.length === 1 || toAppError(err).code !== 'format') throw err
      const half = Math.ceil(batch.length / 2)
      return [...(await this.translateParagraphs(batch.slice(0, half), all)), ...(await this.translateParagraphs(batch.slice(half), all))]
    } finally {
      this.activeRequests.delete(requestId)
    }
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
    if (this.novel) {
      const numbers = this.pages.map((p) => p.number)
      const pdf = await buildNovelPdf(await this.doc.getData(), this.novelFlow, this.novelText, await novelLayout(this.doc, numbers), title)
      // The cover is the original's first page (a novel's cover is a picture, kept as it is).
      const first = await createImageBitmap(new Blob([(await this.renderOriginal(numbers[0])).jpeg as BlobPart], { type: 'image/jpeg' }))
      const cover = await canvasToBytes(thumbnailCanvas(first, 480), 'image/jpeg', 0.85)
      first.close()
      return { pdf, cover }
    }
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

  /** Detects and translates a page without drawing it (rebuilding the training dataset from the cache). */
  async readPage(pageNumber: number): Promise<number> {
    const page = await this.detect(pageNumber)
    return (await this.translateSlices(pageNumber, page.prepared)).length
  }

  private async processPage(pageNumber: number): Promise<void> {
    await this.guard(pageNumber, async () => {
      if (await this.fromLayer(pageNumber)) return
      const page = await this.detect(pageNumber)
      const blocks = await this.translateSlices(pageNumber, page.prepared)
      await this.draw(pageNumber, page, blocks)
    })
  }

  /** Runs one step of a page; a failure marks the page (and stops the run when every page would fail alike). */
  private async guard(pageNumber: number, step: () => Promise<unknown>): Promise<void> {
    try {
      await step()
    } catch (err) {
      if (this.cancelled) {
        this.update(pageNumber, { status: 'pending', parts: undefined, stage: undefined })
        return
      }
      const error = toAppError(err)
      this.update(pageNumber, { status: 'error', error, stage: undefined })
      if (FATAL_ERRORS.has(error.code)) {
        this.stopReason = error
        this.cancel()
      }
    }
  }

  /** Renders the page and finds its text and bubbles. */
  private async detect(pageNumber: number, stage?: string): Promise<Detected & { canvas: HTMLCanvasElement; prepared: PreparedSlice[] }> {
    const started = performance.now()
    this.update(pageNumber, { status: 'working', error: undefined, parts: undefined, stage })
    const { widthPt, heightPt } = await pageSize(this.doc, pageNumber)
    const tall = isTallPage(widthPt, heightPt)
    const canvas = await renderForTranslation(this.doc, pageNumber)
    const scene = await analyzePage(canvas)
    return { started, widthPt, heightPt, tall, scene, canvas, prepared: await prepareSlices(canvas, tall, scene) }
  }

  /** Sends the page's slices to the model; blocks come back in page pixels. */
  private async translateSlices(pageNumber: number, prepared: PreparedSlice[]): Promise<TextBlock[]> {
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
            const blocks = await window.api.translate({ images, key, regions, pageNumber, requestId, chapter: this.chapter })
            this.update(pageNumber, { parts: { done: ++done, total: chunks.length } })
            return blocks.flatMap((list, i) => list.map((b) => toPageSpace(b, part[i].scale, part[i].offsetY)))
          } finally {
            this.activeRequests.delete(requestId)
          }
        })
      )
    )
    if (this.cancelled) throw new Error(CANCELLED)
    return dedupe(results.flat())
  }

  /** Erases the original lettering, writes the translation and stores the finished page. */
  private async draw(
    pageNumber: number,
    page: Detected & { canvas: HTMLCanvasElement; prepared: PreparedSlice[] },
    blocks: TextBlock[]
  ): Promise<void> {
    const { canvas, prepared, scene, widthPt, heightPt } = page
    this.blocks.set(pageNumber, blocks)
    await ensureFonts()
    const pagePx = canvas.height
    const before = this.onPageRendered ? cropCanvas(canvas, { x: 0, y: 0, width: canvas.width, height: pagePx }, Infinity) : null
    const drawn = await drawOverlayOff(canvas, blocks, scene)
    const heightPtOut = heightPt * (canvas.height / pagePx)
    if (before) {
      const regions = prepared.flatMap((p) =>
        p.regions.map(({ box: b }): Box => [b[0] * p.scale, b[1] * p.scale + p.offsetY, b[2] * p.scale, b[3] * p.scale + p.offsetY])
      )
      await this.onPageRendered?.(pageNumber, before, canvas, regions, drawn)
    }

    if (this.layers) await this.keepLayer(pageNumber, canvas, blocks.length)
    await this.finishPage(pageNumber, canvas, widthPt, heightPtOut, blocks.length, page.started)
  }

  private async finishPage(pageNumber: number, canvas: HTMLCanvasElement, widthPt: number, heightPt: number, blockCount: number, started: number): Promise<void> {
    const jpeg = await canvasToBytes(canvas, 'image/jpeg', 0.9)
    this.outputs.set(pageNumber, { jpeg, widthPt, heightPt })
    this.update(pageNumber, {
      status: 'done',
      stage: undefined,
      blockCount,
      ms: performance.now() - started,
      imageUrl: jpegUrl(jpeg),
      thumbUrl: URL.createObjectURL(await canvasToBlob(thumbnailCanvas(canvas, THUMB_LONG_SIDE), 'image/jpeg', 0.8))
    })
  }

  /** The page put back from the layer saved when it was translated before; false when there is none. */
  private async fromLayer(pageNumber: number): Promise<boolean> {
    if (!this.layers?.reuse) return false
    const started = performance.now()
    const canvas = await renderForTranslation(this.doc, pageNumber)
    const saved = await window.api.layers.get(await layerKey(canvas, this.layers.tag)).catch(() => null)
    if (!saved) return false
    const layer = JSON.parse(saved) as PageLayer
    if (!(await applyLayer(canvas, layer))) return false
    const { widthPt, heightPt } = await pageSize(this.doc, pageNumber)
    await this.finishPage(pageNumber, canvas, widthPt, heightPt, layer.blockCount, started)
    return true
  }

  /** Saves what the translation changed on the page, compared with the page rendered again as it was. */
  private async keepLayer(pageNumber: number, translated: HTMLCanvasElement, blockCount: number): Promise<void> {
    try {
      const original = await renderForTranslation(this.doc, pageNumber)
      if (original.width !== translated.width || original.height !== translated.height) return
      const layer = await extractLayer(original, translated, blockCount)
      await window.api.layers.save(await layerKey(original, this.layers!.tag), JSON.stringify(layer))
    } catch {
      // Only a faster next time is lost.
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
export async function prepareSlices(canvas: HTMLCanvasElement, tall: boolean, scene: Scene | null = null): Promise<PreparedSlice[]> {
  const sliceHeight = Math.round(canvas.width * SLICE_ASPECT)
  const keep = scene
    ? scene.blocks.map((b): [number, number] => [b.box[1] - b.letterHeight, b.box[3] + b.letterHeight])
    : await textRows(canvas, sliceHeight, tall ? AI_LONG_SIDE_TALL : AI_LONG_SIDE)
  const slices = planSlices(canvas, sliceHeight, Math.round(sliceHeight * SLICE_OVERLAP), keep)
  const aiLongSide = tall ? AI_LONG_SIDE_TALL : AI_LONG_SIDE
  const prepared: PreparedSlice[] = []
  for (const slice of slices) {
    const crop = cropCanvas(canvas, { x: 0, y: slice.y0, width: canvas.width, height: slice.y1 - slice.y0 }, aiLongSide)
    const scale = canvas.width / crop.width
    const cutTop = slice.y0 > 0
    const cutBottom = slice.y1 < canvas.height
    const found = (await detectTextOff(crop)).filter((r) => !(cutTop && r.box[1] <= 2) && !(cutBottom && r.box[3] >= crop.height - 2))
    // The models find the text; the built-in detector only adds what they missed (small remarks), and
    // the translation model skips its boxes that hold no text.
    const regions = scene
      ? withExtras(regionsInSlice(scene, slice.y0, slice.y1, scale), regionsInSlice(scene, slice.y0, slice.y1, scale, true), found)
      : found
    prepared.push({ crop, regions, offsetY: slice.y0, scale })
  }
  boxOnce(prepared)
  return prepared
}

/**
 * Without the models' blocks, the rows the built-in detector finds text on, over the whole page: the
 * blank gap between two lines of a narration on white looks like a gutter between panels, and a cut
 * there left the lines under it at the slice's edge, dropped as cut text (chapter 79 of The Genius
 * Midfielder: "Even a child whose" translated, the two lines under it left in English).
 */
async function textRows(canvas: HTMLCanvasElement, sliceHeight: number, longSide: number): Promise<[number, number][]> {
  if (canvas.height <= sliceHeight * 1.15) return []
  const whole = cropCanvas(canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height }, longSide)
  const scale = canvas.width / whole.width
  return (await detectTextOff(whole)).map((r): [number, number] => [(r.box[1] - r.letterHeight) * scale, (r.box[3] + r.letterHeight) * scale])
}

/** `around` also holds the models' blocks cut by the slice edge: lines of those found here are not extra. */
function withExtras(models: TextRegion[], around: TextRegion[], extra: TextRegion[]): TextRegion[] {
  const area = (b: Box) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
  const overlaps = (a: Box, b: Box) => {
    const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
    const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
    return ix > 0 && iy > 0 && ix * iy > 0.2 * Math.min(area(a), area(b))
  }
  return [...models, ...extra.filter((e) => !around.some((m) => overlaps(m.box, e.box)))]
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
