/** How much of the disk the PC app takes, shown on its storage page and on the phone's. */

/** What can be cleared on its own: it is made again when needed. */
export type StorageArea = 'layers' | 'aiCache' | 'appCache'

export interface StorageUsage {
  /** Each work's chapters on this PC, the biggest first. */
  works: { workId: string; name: string; chapters: number; translated: number; original: number; other: number }[]
  areas: {
    /** The translated pages kept as only what changed on them, to translate a chapter again in moments. */
    layers: { bytes: number; files: number }
    /** The AI's answers, so the same page is not paid for twice. */
    aiCache: { bytes: number; files: number }
    /** The window's own caches. */
    appCache: { bytes: number; files: number }
    /** The local AI models downloaded. */
    models: { bytes: number; files: number }
    /** The queue, with the PDFs phones sent to translate. */
    phoneUploads: { bytes: number; files: number }
  }
  total: number
  /** Free space on the disk the app is on; null when unknown. */
  free: number | null
}

/** "1,4 GB", "820 MB", "12 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`
}
