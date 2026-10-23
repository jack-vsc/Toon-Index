import type { WorkFormat } from './works'

/**
 * Chapters read in the browser (sent by the extension), found in the browsers' history or read
 * translated in the app. Each work keeps where it was left, so it survives the site it was read on.
 */

export type ReadingStatus = 'read' | 'reading'

export interface ReadingRecord {
  /** Work.id in shared/works. */
  workId: string
  chapter: number
  /** 'reading' when it is not known the chapter was finished: left midway, or only seen in the history. */
  status: ReadingStatus
  /** How far down the chapter's pages the reader got, 0 to 1; null when unknown (history, page-by-page readers). */
  progress: number | null
  /** Where it was read; the chapter's page on the site, or empty for chapters read in the app. */
  url: string
  /** The page's title as the site wrote it. */
  title: string
  source: 'browser' | 'history' | 'app' | 'manual'
  updatedAt: number
}

/** What the extension sends while a chapter page is open. */
export interface ReadingReport {
  url: string
  title: string
  progress: number | null
  /** Reached the last of the chapter's pages after reading long enough for it to count. */
  finished: boolean
  at?: number
}

/** One chapter found in the browsers' history, before it is imported. */
export interface HistoryChapter {
  url: string
  title: string
  chapter: number
  at: number
}

/** The chapters of one work found in the history, offered for import together. */
export interface HistoryWork {
  /** The name the chapters were found under. */
  name: string
  /** The known work it would go to, when one matches. */
  workId: string | null
  format: WorkFormat
  browsers: string[]
  sites: string[]
  chapters: HistoryChapter[]
}
