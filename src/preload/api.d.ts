import type {
  AiMonitorStatus,
  AiStopTarget,
  ApiProfile,
  EvalConfig,
  GpuStatus,
  LibraryEntry,
  ModelOption,
  PublicSettings,
  SaveLibraryInput,
  SaveSettingsInput,
  TextBlock,
  TranslateRequest,
  VisionDetection,
  WebChapter,
  WebChapterProgress
} from '../shared/types'
import type { DevicesStatus, PairingCode } from '../shared/devices'
import type { HistoryWork, ReadingRecord } from '../shared/reading'
import type { RemoteJob, RemoteQueue } from '../shared/remoteJobs'
import type { ChapterLink, UpdatesStatus } from '../shared/updates'
import type { CatalogMatch, CatalogResult, CatalogSite } from '../shared/catalog'
import type { Work } from '../shared/works'

export interface MangaApi {
  getSettings(): Promise<PublicSettings>
  saveSettings(input: SaveSettingsInput): Promise<PublicSettings>
  /** `apiKey` is a key typed but not saved yet; the saved one is used otherwise. */
  listModels(profile: ApiProfile, apiKey?: string): Promise<{ models: ModelOption[]; suggested: string }>
  /** Sends a tiny request with an image; rejects with the reason when the API or model can't be used. */
  testApi(profile: ApiProfile, apiKey?: string): Promise<{ ms: number }>
  /** Returns one list of blocks per image in the request. */
  translate(req: TranslateRequest): Promise<TextBlock[][]>
  /** Pretrained manga models (text + speech bubbles, LaMa inpainting) run by the Python vision server. */
  vision: {
    detect(image: Uint8Array): Promise<VisionDetection>
    /** `mask` is a PNG, white where the page is repainted; returns the page as PNG. */
    inpaint(image: Uint8Array, mask: Uint8Array): Promise<Uint8Array>
  }
  /** Chapters read from a link to a site's reader page. */
  web: {
    chapter(url: string): Promise<WebChapter>
    cancel(): Promise<void>
    /** A window of the site for the person to sign in; resolves when they close it. */
    login(url: string): Promise<void>
    /** Returns a function that stops listening. */
    onProgress(callback: (p: WebChapterProgress) => void): () => void
  }
  /** Local AIs and the GPU they use; asking for the status keeps a background sampler running a while. */
  ai: {
    status(): Promise<AiMonitorStatus>
    /** The GPU's totals only (quick); null without an NVIDIA GPU. */
    gpu(): Promise<GpuStatus | null>
    stop(target: AiStopTarget): Promise<void>
  }
  /** Aborts running requests (all of them when no ids are given). */
  cancelTranslations(requestIds?: string[]): Promise<void>
  savePdf(bytes: Uint8Array, suggestedName: string): Promise<string | null>
  showFile(path: string): Promise<void>
  library: {
    list(): Promise<LibraryEntry[]>
    save(input: SaveLibraryInput): Promise<LibraryEntry>
    pdf(id: string, which: 'original' | 'translated'): Promise<Uint8Array>
    remove(id: string): Promise<void>
  }
  /** Works (titles) the library's chapters are grouped by, each with every name it is known by. */
  works: {
    list(): Promise<Work[]>
    setNames(workId: string, names: string[]): Promise<Work[]>
    /** Moves every chapter of `fromId` into `intoId`, which also takes its names. */
    merge(intoId: string, fromId: string): Promise<Work[]>
    move(entryId: string, target: { workId: string } | { newName: string }): Promise<Work[]>
    /** By work id, the covers found on the catalog sites (data URLs). */
    covers(): Promise<Record<string, string>>
    /** Every chapter of a work on MangaDex or mgeko, or on any site from its page's link ('link'), in order. */
    chapters(match: { site: CatalogSite | 'link'; url: string }): Promise<ChapterLink[]>
    /** Looks a name up on MangaDex, mgeko and comix. */
    search(query: string): Promise<CatalogResult[]>
    /** Takes the chosen matches' names, pages and cover into the work. */
    link(workId: string, matches: CatalogMatch[]): Promise<Work[]>
  }
  /** Phones paired with the app (the Android app reaches it on the home network or Tailscale). */
  devices: {
    status(): Promise<DevicesStatus>
    /** Turns answering phones on the network on or off. */
    enable(enabled: boolean): Promise<DevicesStatus>
    /** A new pairing code (and its QR code), good for ten minutes. */
    pairing(): Promise<PairingCode>
    revoke(id: string): Promise<DevicesStatus>
  }
  /** New chapters on the works' sites, checked every couple of hours. */
  updates: {
    status(): Promise<UpdatesStatus>
    /** Checks every work's sites now; resolves when done. */
    check(): Promise<void>
    /** The work's pages on sites (up to three) to check. */
    setSources(workId: string, sources: string[]): Promise<void>
    /** Phone notifications through ntfy: on (with a new private topic) or off. */
    setNtfy(enabled: boolean): Promise<UpdatesStatus>
    /** Returns a function that stops listening. */
    onChanged(callback: () => void): () => void
  }
  /** Chapters the phone asked this PC to translate. */
  remote: {
    list(): Promise<RemoteJob[]>
    /** The next queued job, now marked running, with the PDF the phone sent (null for a link). */
    take(): Promise<{ job: RemoteJob; pdf: Uint8Array | null } | null>
    update(id: string, patch: Partial<Pick<RemoteJob, 'status' | 'message' | 'entryId'>>): Promise<void>
    /** Every job, and whether the queue is paused. */
    queue(): Promise<RemoteQueue>
    /** Pauses (nothing new starts) or resumes the queue. */
    pause(paused: boolean): Promise<RemoteQueue>
    /** Queues a range of a work's chapters, to translate (or only download) in order. */
    /** `source`: the work's page the chapters came from, added to the work's sites. */
    batch(work: string, site: string, chapters: ChapterLink[], download: boolean, source?: string): Promise<RemoteQueue>
    /** Takes the queued chapters of those ranges off the queue. */
    clearBatch(): Promise<RemoteQueue>
    /** Returns a function that stops listening. */
    onChanged(callback: () => void): () => void
  }
  /** Where each work was left: chapters read in the browser (extension), the history, or the app. */
  reading: {
    list(): Promise<ReadingRecord[]>
    /** A library chapter read to its last page. */
    finished(entryId: string): Promise<void>
    /** Marks a chapter read by hand (read on the phone, say). */
    mark(workId: string, chapter: number): Promise<void>
    /** Forgets one chapter, or the whole work's reading when `chapter` is null. */
    forget(workId: string, chapter: number | null): Promise<void>
    scanHistory(): Promise<{ works: HistoryWork[]; problems: string[] }>
    /** Returns how many chapters were imported. */
    importHistory(works: HistoryWork[]): Promise<number>
    /** Opens the browser extension's folder. */
    openExtension(): Promise<string>
    /** Returns a function that stops listening. */
    onChanged(callback: () => void): () => void
  }
  /** Developer evaluation runs; `config` resolves to null in normal use. */
  evaluation: {
    config(): Promise<EvalConfig | null>
    read(path: string): Promise<Uint8Array>
    write(name: string, data: Uint8Array | string): Promise<void>
    log(message: string): Promise<void>
    done(): Promise<void>
  }
}

declare global {
  interface Window {
    api: MangaApi
  }
}
