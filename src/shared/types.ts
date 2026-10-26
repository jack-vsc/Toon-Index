export type ProviderKind = 'cursor' | 'openai'

/** One registered API. Its key is stored apart (encrypted), under the profile id. */
export interface ApiProfile {
  id: string
  name: string
  kind: ProviderKind
  /** OpenAI-compatible endpoint; unused by Cursor profiles. */
  baseUrl: string
  /** Model IDs added by the user (OpenAI-compatible profiles; Cursor lists its models itself). */
  models: string[]
  /** Model used to translate. */
  model: string
}

/** [x0, y0, x1, y1] in pixels of the image that was sent to the model. */
export type Box = [number, number, number, number]

export type BlockKind = 'speech' | 'thought' | 'shout' | 'whisper' | 'narration' | 'system' | 'aside' | 'signage' | 'sfx' | 'watermark' | 'other'

/** Typeface family of the original lettering, as scanlators classify it. */
export type FontRole = 'comic' | 'brush' | 'condensed' | 'sans' | 'serif' | 'handwritten'

export interface TextBlock {
  /** Tightly covers the original glyphs; this region gets painted over. */
  textBox: Box
  /** Free space available for the translation (e.g. bubble interior). Always contains textBox. */
  areaBox: Box
  /** Boxes the app's text detector drew around this block's lettering: every glyph in them gets erased. */
  inkBoxes?: Box[]
  /** Letter height the detector measured in those boxes. */
  letterHeight?: number
  original: string
  translation: string
  kind: BlockKind
  /** Look of the original lettering, as described by the model (absent in old cached answers). */
  font?: FontRole
  italic?: boolean
  /** '#rrggbb' fill and outline colours of the original letters. */
  color?: string
  outline?: string
}

/** Trade-off between latency and accuracy; mapped onto each model's reasoning parameters. */
export type Speed = 'fast' | 'balanced' | 'quality'

/** 'scroll' = continuous vertical strip (webtoon), 'paged' = one page at a time (manga). */
export type ReaderMode = 'scroll' | 'paged'

export interface AppSettings {
  activeProfileId: string
  profiles: ApiProfile[]
  sourceLanguage: string
  targetLanguage: string
  translateSfx: boolean
  concurrency: number
  speed: Speed
  /** Pages left untranslated at the start / end of a whole-PDF run (scanlator credit pages). */
  skipStart: number
  skipEnd: number
  readerMode: ReaderMode
  gpuSharing: GpuSharing
  /** Where the local translation model (Ollama) runs. */
  aiDevice: AiDevice
  /** Where the vision server (text and bubble detection, LaMa) runs: on the processor it leaves the GPU free. */
  visionDevice: AiDevice
}

/** The options a chapter is translated with, chosen when it is sent (on the PC, or from the phone). */
export type TranslateOptions = Pick<
  AppSettings,
  | 'activeProfileId'
  | 'sourceLanguage'
  | 'targetLanguage'
  | 'concurrency'
  | 'speed'
  | 'translateSfx'
  | 'skipStart'
  | 'skipEnd'
  | 'gpuSharing'
  | 'aiDevice'
  | 'visionDevice'
>

export const TRANSLATE_OPTION_KEYS: (keyof TranslateOptions)[] = [
  'activeProfileId',
  'sourceLanguage',
  'targetLanguage',
  'concurrency',
  'speed',
  'translateSfx',
  'skipStart',
  'skipEnd',
  'gpuSharing',
  'aiDevice',
  'visionDevice'
]

/** 'cpu' runs them on the processor and RAM, for computers without a graphics card (several times slower). */
export type AiDevice = 'gpu' | 'cpu'

/**
 * How the AIs share the GPU during a run: 'phased' runs one at a time over the whole chapter (detection,
 * translation, lettering), for small GPUs and local translation models; 'together' goes page by page;
 * 'auto' picks 'phased' for a local model on a GPU under 12 GB.
 */
export type GpuSharing = 'auto' | 'phased' | 'together'

export interface PublicSettings extends AppSettings {
  /** By profile id. */
  hasKey: Record<string, boolean>
  /** Last characters of each saved key, so the user can see which one is stored. */
  keyHint: Record<string, string | null>
}

export interface SaveSettingsInput {
  settings: AppSettings
  /** By profile id. Only the profiles present here get their key replaced; empty string clears it. */
  apiKeys?: Record<string, string>
}

export function activeProfile(settings: AppSettings): ApiProfile | undefined {
  return settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
}

/** A model served on this computer (Ollama, LM Studio…): it needs no API key. */
export function isLocalProfile(profile: ApiProfile): boolean {
  if (profile.kind !== 'openai') return false
  try {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(new URL(profile.baseUrl).hostname)
  } catch {
    return false
  }
}

/** Whether translating with the profile can start: a model chosen and, unless it runs here, a saved key. */
export function profileReady(profile: ApiProfile | undefined, hasKey: Record<string, boolean>): boolean {
  return !!profile && !!profile.model && (!!hasKey[profile.id] || isLocalProfile(profile))
}

export interface PageImage {
  base64: string
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
}

/** Error message of a request aborted by the user. */
export const CANCELLED = 'Cancelado pelo usuário.'

/** A block of lettering found by the app and drawn on the image as a numbered box. */
export interface MarkedRegion {
  /** Unique within the request. */
  id: number
  /** Index of the image in the request. */
  image: number
  /** Tight box around the glyphs, in pixels of that image. */
  box: Box
  /** Typical letter height and number of glyphs the detector measured. */
  letterHeight: number
  glyphs: number
}

/** A block of text found by the vision models, in pixels of the analysed image. */
export interface VisionBlock {
  box: Box
  /** Text lines inside the block. */
  lines: Box[]
  letterHeight: number
  /** Rough number of characters. */
  glyphs: number
  conf: number
  /** Index of the speech bubble holding the block, -1 when it is not in one. */
  bubble: number
}

export interface VisionBubble {
  box: Box
  /** Outline of the bubble's interior, [x, y] points. */
  polygon: [number, number][]
  conf: number
  /** A system window or caption box around the text, not a speech bubble. */
  frame: boolean
}

export interface VisionDetection {
  blocks: VisionBlock[]
  bubbles: VisionBubble[]
  /** PNG, white where the models see lettering. */
  textMask: Uint8Array
}

/** A chapter read from a link: its pages as downloaded (JPEG, PNG, WebP…), in reading order. */
export interface WebChapter {
  title: string
  images: Uint8Array[]
}

/** Where fetching a chapter from a link is; 'challenge' = the site's bot check is shown to the person. */
export type WebChapterProgress =
  | { stage: 'loading' | 'challenge' | 'scrolling' }
  | { stage: 'downloading'; done: number; total: number }

/** The local AIs the app runs or uses: vision server and Ollama. */
export type LocalAiId = 'vision' | 'ollama'

export interface LocalAiStatus {
  id: LocalAiId
  name: string
  /** What it is used for. */
  role: string
  running: boolean
  pids: number[]
  /** Dedicated GPU memory of its processes, MiB; null until the first reading (it takes a few seconds). */
  gpuMemory: number | null
  /** Models loaded in memory (Ollama), with their share on the GPU. */
  models: { name: string; sizeMiB: number; gpuMiB: number }[]
}

export interface GpuStatus {
  name: string
  /** Percent of time the GPU was busy over the last sample. */
  utilization: number
  memoryUsed: number
  memoryTotal: number
  temperature: number | null
}

export interface AiMonitorStatus {
  /** null when nvidia-smi is not available. */
  gpu: GpuStatus | null
  ais: LocalAiStatus[]
  /** Biggest other users of GPU memory (games, browsers), MiB. */
  others: { name: string; pid: number; gpuMemory: number; capped: boolean }[]
}

/** What the monitor's buttons stop: one AI, only Ollama's loaded models, or everything. */
export type AiStopTarget = LocalAiId | 'ollama-models' | 'all'

/** The app's own translation model ("Neste PC"): llama.cpp's server, the build for the card. */
export type LocalAiEngine = 'cuda' | 'vulkan'

export const LOCAL_AI_PROFILE_ID = 'local'
export const LOCAL_AI_BASE_URL = 'http://127.0.0.1:47380/v1'

export interface LocalAiProgress {
  task: string
  done: number
  total: number
}

export interface LocalAiModelStatus {
  id: string
  label: string
  note: string
  /** Bytes to download. */
  size: number
  /** 'ollama': used from Ollama's files; 'in-ollama': Ollama has it, not in use yet. */
  state: 'downloaded' | 'ollama' | 'in-ollama' | 'missing'
}

export interface LocalAiState {
  recommended: LocalAiEngine
  engines: { id: LocalAiEngine; label: string; size: number; installed: boolean }[]
  models: LocalAiModelStatus[]
  progress: LocalAiProgress | null
  running: { model: string } | null
}

/** Developer evaluation run (MI_EVAL_* environment variables): sample pages and a reference translation. */
export interface EvalConfig {
  pdf: string
  /** Images of the same chapter translated by hand, top to bottom, forming one continuous strip. */
  reference: string[]
  /** 1-based pages to translate; all when null. */
  pages: number[] | null
  /** Only save the slices with the detected text marked, without calling the model. */
  detectOnly: boolean
}

/** One model request: one or more consecutive vertical slices of the same page, top to bottom. */
export interface TranslateRequest {
  images: PageImage[]
  /** Every marked region enlarged and tagged with its number, sent after `images`. */
  key: PageImage[]
  regions: MarkedRegion[]
  pageNumber: number
  /** Lets the renderer cancel this request while it is running. */
  requestId: string
}

export interface ModelOption {
  id: string
  label: string
  /** e.g. "$0.30 / $2.50 por 1M tokens", when the API lists prices. */
  price?: string
}

export interface LibraryEntry {
  id: string
  title: string
  fileName: string
  createdAt: number
  pageCount: number
  translatedPages: number
  sourceLanguage: string
  targetLanguage: string
  model: string
  /** data: URL of a small cover image. */
  cover: string
  /** The work (Work.id in shared/works) the chapter belongs to. */
  workId: string
  chapter: number | null
  /** Link the chapter was read from, when it came from a site. */
  source?: string
}

/** The model named for a chapter saved as the site had it (a scan already in the language read). */
export const DOWNLOADED_MODEL = 'baixado sem tradução'

/** The chapter was downloaded as it is, not translated. */
export const isDownloaded = (entry: Pick<LibraryEntry, 'model'>): boolean => entry.model === DOWNLOADED_MODEL

/** "5 TRADUZIDOS · 3 BAIXADOS": a work's chapters on this PC, by how they got here. */
export function chapterCount(entries: Pick<LibraryEntry, 'model'>[], short = false): string {
  const downloaded = entries.filter(isDownloaded).length
  const translated = entries.length - downloaded
  return [
    translated && `${translated} ${short ? 'TRAD.' : 'TRADUZIDOS'}`,
    downloaded && `${downloaded} ${short ? 'BAIX.' : 'BAIXADOS'}`
  ]
    .filter(Boolean)
    .join(' · ')
}

export interface SaveLibraryInput {
  fileName: string
  source?: string
  pageCount: number
  translatedPages: number
  original: Uint8Array
  translated: Uint8Array
  coverJpeg: Uint8Array
  /** Downloaded as it is, already in the language read (the translated PDF is the original). */
  downloaded?: boolean
}

export interface Language {
  /** Sent to the model, so it is in English. */
  value: string
  label: string
}

export const AUTO_LANGUAGE = 'auto'

export const LANGUAGES: Language[] = [
  { value: 'Japanese', label: 'Japonês' },
  { value: 'Korean', label: 'Coreano' },
  { value: 'Simplified Chinese', label: 'Chinês (simplificado)' },
  { value: 'Traditional Chinese', label: 'Chinês (tradicional)' },
  { value: 'English', label: 'Inglês' },
  { value: 'Brazilian Portuguese', label: 'Português (Brasil)' },
  { value: 'European Portuguese', label: 'Português (Portugal)' },
  { value: 'Spanish', label: 'Espanhol' },
  { value: 'French', label: 'Francês' },
  { value: 'Italian', label: 'Italiano' },
  { value: 'German', label: 'Alemão' },
  { value: 'Russian', label: 'Russo' },
  { value: 'Indonesian', label: 'Indonésio' },
  { value: 'Thai', label: 'Tailandês' },
  { value: 'Vietnamese', label: 'Vietnamita' },
  { value: 'Arabic', label: 'Árabe' }
]

export function languageLabel(value: string): string {
  if (value === AUTO_LANGUAGE) return 'Detectar automaticamente'
  return LANGUAGES.find((l) => l.value === value)?.label ?? value
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeProfileId: 'cursor',
  profiles: [{ id: 'cursor', name: 'Cursor', kind: 'cursor', baseUrl: '', models: [], model: '' }],
  sourceLanguage: AUTO_LANGUAGE,
  targetLanguage: 'Brazilian Portuguese',
  translateSfx: false,
  concurrency: 3,
  speed: 'fast',
  skipStart: 0,
  skipEnd: 0,
  readerMode: 'scroll',
  gpuSharing: 'auto',
  aiDevice: 'gpu',
  visionDevice: 'gpu'
}
