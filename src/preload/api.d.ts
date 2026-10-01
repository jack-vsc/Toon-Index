import type {
  ApiProfile,
  LibraryEntry,
  ModelOption,
  PublicSettings,
  SaveLibraryInput,
  SaveSettingsInput,
  TextBlock,
  TranslateRequest
} from '../shared/types'

export interface MangaApi {
  getSettings(): Promise<PublicSettings>
  saveSettings(input: SaveSettingsInput): Promise<PublicSettings>
  /** `apiKey` is a key typed but not saved yet; the saved one is used otherwise. */
  listModels(profile: ApiProfile, apiKey?: string): Promise<{ models: ModelOption[]; suggested: string }>
  /** Sends a tiny request with an image; rejects with the reason when the API or model can't be used. */
  testApi(profile: ApiProfile, apiKey?: string): Promise<{ ms: number }>
  /** Returns one list of blocks per image in the request. */
  translate(req: TranslateRequest): Promise<TextBlock[][]>
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
}

declare global {
  interface Window {
    api: MangaApi
  }
}
