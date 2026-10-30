import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HistoryChapter, HistoryWork, ReadingRecord, ReadingReport } from '../shared/reading'
import { chapterInUrl, findWork, isNovelUrl, parseChapterName, sameName } from '../shared/works'
import { indexWork, listWorks, readMeta, startedReading } from './library'

const readingPath = (): string => join(app.getPath('userData'), 'library', 'reading.json')

const listeners = new Set<() => void>()

/** Called whenever a chapter is marked read or its position changes. */
export function onReadingChanged(listener: () => void): void {
  listeners.add(listener)
}

export function listReading(): ReadingRecord[] {
  try {
    return (JSON.parse(readFileSync(readingPath(), 'utf8')) as { records: ReadingRecord[] }).records
  } catch {
    return []
  }
}

/** The library changed from elsewhere (the phone deleted a chapter): the window lists it again. */
export function libraryChangedElsewhere(): void {
  for (const listener of listeners) listener()
}

function saveReading(records: ReadingRecord[]): void {
  mkdirSync(join(app.getPath('userData'), 'library'), { recursive: true })
  writeFileSync(readingPath(), JSON.stringify({ records }, null, 2))
  for (const listener of listeners) listener()
}

/**
 * Records a chapter as read or as where the reader is. Never goes back: a chapter once read stays
 * read, and the position only moves forward. Opening a chapter means the one before it was finished.
 */
function upsert(records: ReadingRecord[], next: ReadingRecord): ReadingRecord[] {
  const i = records.findIndex((r) => r.workId === next.workId && r.chapter === next.chapter)
  const old = i >= 0 ? records[i] : null
  const merged: ReadingRecord = old
    ? {
        ...old,
        status: old.status === 'read' || next.status === 'read' ? 'read' : 'reading',
        progress: old.progress === null ? next.progress : next.progress === null ? old.progress : Math.max(old.progress, next.progress),
        // The latest place it was read at; history never replaces what the extension saw.
        ...(next.updatedAt >= old.updatedAt && (next.source !== 'history' || old.source === 'history')
          ? { url: next.url || old.url, title: next.title || old.title, source: next.source, updatedAt: next.updatedAt }
          : {})
      }
    : next
  const result = i >= 0 ? records.map((r, j) => (j === i ? merged : r)) : [...records, merged]
  // In whichever order they arrive (the history may bring an older chapter after a newer one).
  const chapters = result.filter((r) => r.workId === next.workId).map((r) => r.chapter)
  return result.map((r) =>
    r.workId === next.workId && r.status === 'reading' && chapters.some((c) => c > r.chapter && c <= r.chapter + 1)
      ? { ...r, status: 'read', progress: 1 }
      : r
  )
}

/** A chapter page open in the browser; null when the page does not name a chapter of something. */
export function reportReading(report: ReadingReport): (ReadingRecord & { work: string }) | null {
  const parsed = parseChapterName(report.title, report.url)
  if (parsed.chapter === null || !parsed.work) return null
  const workId = indexWork(parsed.work, isNovelUrl(report.url) ? 'novel' : 'comic')
  const records = upsert(listReading(), {
    workId,
    chapter: parsed.chapter,
    status: report.finished ? 'read' : 'reading',
    progress: report.progress === null ? null : Math.min(1, Math.max(0, report.progress)),
    url: report.url,
    title: report.title,
    source: 'browser',
    updatedAt: report.at ?? Date.now()
  })
  saveReading(records)
  startedReading(workId)
  const saved = records.find((r) => r.workId === workId && r.chapter === parsed.chapter)!
  const work = listWorks().find((w) => w.id === workId)?.names[0] ?? parsed.work
  return { ...saved, work }
}

/** A translated chapter of the library read to its last page in the app. */
export function finishedInApp(entryId: string): void {
  readInApp(entryId, 1)
}

/**
 * How far into a library chapter the reader got in the app (the PC's or the phone's, which may send
 * it later, `at` the time it was read); the last page counts as read.
 */
export function readInApp(entryId: string, progress: number, at = Date.now()): void {
  const meta = readMeta(entryId)
  if (meta.chapter === null) return
  const clamped = Math.min(1, Math.max(0, progress))
  saveReading(
    upsert(listReading(), {
      workId: meta.workId,
      chapter: meta.chapter,
      status: clamped >= 1 ? 'read' : 'reading',
      progress: clamped,
      url: meta.source ?? '',
      title: meta.title,
      source: 'app',
      updatedAt: at
    })
  )
  startedReading(meta.workId)
}

/** Readings from another copy of the data (a backup file, the phone), merged as any reading is. */
export function mergeRecords(incoming: ReadingRecord[]): void {
  if (!incoming.length) return
  saveReading(incoming.reduce(upsert, listReading()))
  for (const workId of new Set(incoming.map((r) => r.workId))) startedReading(workId)
}

/** Chapters marked read by hand (read somewhere the app could not see, like the phone): one, or a run of them. */
export function markRead(workId: string, chapters: number | number[]): void {
  const at = Date.now()
  const list = Array.isArray(chapters) ? chapters : [chapters]
  saveReading(
    list.reduce(
      (records, chapter) => upsert(records, { workId, chapter, status: 'read', progress: 1, url: '', title: '', source: 'manual', updatedAt: at }),
      listReading()
    )
  )
}

/**
 * Chapters marked unread: their reading forgotten (one, a run of them, or every chapter of the work
 * when `chapters` is null).
 */
export function forgetReading(workId: string, chapters: number | number[] | null): void {
  const list = chapters === null ? null : new Set(Array.isArray(chapters) ? chapters : [chapters])
  saveReading(listReading().filter((r) => r.workId !== workId || (list !== null && !list.has(r.chapter))))
}

/** The chapters of `fromId` go to `intoId` when two works are merged. */
export function moveReading(fromId: string, intoId: string): void {
  const records = listReading()
  if (!records.some((r) => r.workId === fromId)) return
  saveReading(
    records
      .filter((r) => r.workId === fromId)
      .reduce((all, r) => upsert(all, { ...r, workId: intoId }), records.filter((r) => r.workId !== fromId))
  )
}

// ---------------------------------------------------------------------------------------------------
// Browser history

/** Sites whose "episode 3" or "chapter 2" is not a manga's. */
const NOT_MANGA =
  /(^|\.)(youtube|google|netflix|crunchyroll|primevideo|disneyplus|max|wikipedia|github|stackoverflow|reddit|twitter|x|facebook|instagram|chatgpt|claude|bing|duckduckgo|twitch|spotify|amazon)\.[a-z.]+$/i

interface HistoryFile {
  browser: string
  path: string
}

/** The History databases of Chrome, Brave, Opera (and GX) and Edge, every profile. */
function historyFiles(): HistoryFile[] {
  const local = process.env.LOCALAPPDATA ?? ''
  const roaming = process.env.APPDATA ?? ''
  const files: HistoryFile[] = []
  const profiles = (browser: string, userData: string) => {
    if (!existsSync(userData)) return
    for (const dir of readdirSync(userData)) {
      const path = join(userData, dir, 'History')
      if ((dir === 'Default' || dir.startsWith('Profile ')) && existsSync(path)) files.push({ browser, path })
    }
  }
  profiles('Chrome', join(local, 'Google', 'Chrome', 'User Data'))
  profiles('Brave', join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'))
  profiles('Edge', join(local, 'Microsoft', 'Edge', 'User Data'))
  for (const [browser, dir] of [
    ['Opera', 'Opera Stable'],
    ['Opera GX', 'Opera GX Stable']
  ]) {
    for (const path of [join(roaming, 'Opera Software', dir, 'History'), join(roaming, 'Opera Software', dir, 'Default', 'History')]) {
      if (existsSync(path)) files.push({ browser, path })
    }
  }
  return files
}

/** Chromium keeps time as microseconds since 1601 (read here already in milliseconds). */
const fromChromeTime = (ms: number): number => ms - 11644473600000

interface Found extends HistoryChapter {
  work: string
  browser: string
}

/** Chapter pages in one browser profile's history. */
function readHistory(file: HistoryFile): Found[] {
  // The browser keeps its database locked while open; a copy can be read.
  const copy = join(tmpdir(), `manga-index-history-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`)
  copyFileSync(file.path, copy)
  try {
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const rows = db.prepare("SELECT url, title, last_visit_time / 1000 AS at FROM urls WHERE title != ''").all() as {
        url: string
        title: string
        at: number
      }[]
      const found: Found[] = []
      for (const row of rows) {
        let host: string
        try {
          const u = new URL(row.url)
          if (!/^https?:$/.test(u.protocol)) continue
          host = u.hostname
        } catch {
          continue
        }
        // Video sites ("Assistir … Episódio 5") and error pages kept in the history.
        if (NOT_MANGA.test(host) || /anime/i.test(host) || /^\s*(assistir|watch)/i.test(row.title)) continue
        if (/^\s*\d{3}|error occurred|not found|não encontrad/i.test(row.title)) continue
        // The link has to name the chapter too: titles alone ("Chapter 3 - Getting started") say little.
        const parsed = parseChapterName(row.title, row.url)
        if (parsed.chapter === null || !parsed.work) continue
        const inUrl = chapterInUrl(row.url)
        if (inUrl !== parsed.chapter && !new RegExp(`[/_-]${String(parsed.chapter).replace('.', '[.-]')}(?:[/_.-]|$)`).test(new URL(row.url).pathname)) continue
        found.push({ url: row.url, title: row.title, chapter: parsed.chapter, at: fromChromeTime(row.at), work: parsed.work, browser: file.browser })
      }
      return found
    } finally {
      db.close()
    }
  } finally {
    rmSync(copy, { force: true })
  }
}

/** Chapters found in every browser's history, grouped by work; the most recently read work first. */
export function scanHistory(): { works: HistoryWork[]; problems: string[] } {
  const problems: string[] = []
  const found: Found[] = []
  const files = historyFiles()
  if (!files.length) problems.push('Nenhum histórico do Chrome, Brave, Opera ou Edge foi encontrado neste computador.')
  for (const file of files) {
    try {
      found.push(...readHistory(file))
    } catch (err) {
      problems.push(`${file.browser}: não deu para ler o histórico (${(err as Error).message}). Feche o navegador e tente de novo.`)
    }
  }

  const works = listWorks()
  const groups: HistoryWork[] = []
  for (const item of found.sort((a, b) => b.at - a.at)) {
    // The novel and the manga of the same name are two works.
    const format = isNovelUrl(item.url) ? 'novel' : 'comic'
    const known = findWork(works, item.work, format)
    let group = known
      ? groups.find((g) => g.workId === known.id)
      : groups.find((g) => !g.workId && g.format === format && sameName(g.name, item.work))
    if (!group) {
      group = { name: known ? known.names[0] : item.work, workId: known?.id ?? null, format, browsers: [], sites: [], chapters: [] }
      groups.push(group)
    }
    const site = new URL(item.url).hostname.replace(/^www\./, '')
    if (!group.browsers.includes(item.browser)) group.browsers.push(item.browser)
    if (!group.sites.includes(site)) group.sites.push(site)
    // The same chapter seen on several sites or browsers counts once, at its latest visit (sorted newest first).
    if (!group.chapters.some((c) => c.chapter === item.chapter)) {
      group.chapters.push({ url: item.url, title: item.title, chapter: item.chapter, at: item.at })
    }
  }
  for (const g of groups) g.chapters.sort((a, b) => a.chapter - b.chapter)
  return { works: groups, problems }
}

/**
 * Imports the chosen works from the history. Every chapter but the last one seen was moved on from,
 * so it counts as read; the last one is where the reader stopped, without knowing whether it was finished.
 */
export function importHistory(chosen: HistoryWork[]): number {
  let records = listReading()
  let count = 0
  for (const group of chosen) {
    const workId = group.workId ?? indexWork(group.name, group.format)
    const last = Math.max(...group.chapters.map((c) => c.chapter))
    for (const c of group.chapters) {
      records = upsert(records, {
        workId,
        chapter: c.chapter,
        status: c.chapter < last ? 'read' : 'reading',
        progress: c.chapter < last ? 1 : null,
        url: c.url,
        title: c.title,
        source: 'history',
        updatedAt: c.at
      })
      count++
    }
  }
  saveReading(records)
  return count
}
