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

export type BlockKind = 'speech' | 'thought' | 'shout' | 'narration' | 'system' | 'aside' | 'signage' | 'sfx' | 'other'

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
}

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
}

export interface SaveLibraryInput {
  fileName: string
  pageCount: number
  translatedPages: number
  original: Uint8Array
  translated: Uint8Array
  coverJpeg: Uint8Array
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
  readerMode: 'scroll'
}
