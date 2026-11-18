import type { ReadingRecord } from '../shared/reading'
import { formatOf, normalizeName, SHELVES, type Shelf, type Work } from '../shared/works'
import { indexWork, listWorks, setWorkNames, setWorkShelf } from './library'
import { listReading, mergeRecords } from './reading'

/**
 * The works and where each was left, as a file (the backup the PC and the phone export) and merged
 * back from one, or from the phone: works matched by id or by any of their names, readings that never
 * go back, lists and favorites kept where they are already set.
 */

export interface DataFile {
  app: 'manga-index'
  kind: 'data'
  version: 1
  exportedAt: number
  works: Work[]
  reading: ReadingRecord[]
}

export function exportData(): DataFile {
  return { app: 'manga-index', kind: 'data', version: 1, exportedAt: Date.now(), works: listWorks(), reading: listReading() }
}

/**
 * The PC's id for a work the phone named: its own id when the PC knows it, else found (or made) by
 * name — works made on the phone have ids of the phone's.
 */
export function resolveWork(id: unknown, name: unknown): string | null {
  if (typeof id === 'string' && listWorks().some((w) => w.id === id)) return id
  return typeof name === 'string' && name.trim() ? indexWork(name) : null
}

/** Merges a backup file or what the phone sends; returns how many works and chapters it held. */
export function mergeData(data: { works?: unknown; reading?: unknown }): { works: number; chapters: number } {
  if (!Array.isArray(data.works) || !Array.isArray(data.reading)) throw new Error('Esse arquivo não é um backup do Toon Index.')
  const ids = new Map<string, string>()
  for (const raw of data.works as Partial<Work>[]) {
    const names = Array.isArray(raw.names) ? raw.names.filter((n): n is string => typeof n === 'string' && !!n.trim()) : []
    if (typeof raw.id !== 'string' || !names.length) continue
    const known = listWorks().find((w) => w.id === raw.id)
    const id = known?.id ?? indexWork(names[0], raw.format === 'novel' ? 'novel' : 'comic')
    ids.set(raw.id, id)
    const work = listWorks().find((w) => w.id === id)!
    const missing = names.filter((n) => !work.names.some((k) => normalizeName(k) === normalizeName(n)))
    // Names another work of the same format already has stay with it.
    const taken = new Set(
      listWorks()
        .filter((w) => w.id !== id && formatOf(w) === formatOf(work))
        .flatMap((w) => w.names.map(normalizeName))
    )
    const added = missing.filter((n) => !taken.has(normalizeName(n)))
    if (added.length) setWorkNames(id, [...work.names, ...added])
    const shelf = typeof raw.shelf === 'string' && raw.shelf in SHELVES ? (raw.shelf as Shelf) : undefined
    if ((shelf && !work.shelf) || (raw.favorite === true && !work.favorite)) {
      setWorkShelf(id, { ...(shelf && !work.shelf && { shelf }), ...(raw.favorite === true && { favorite: true }) })
    }
  }
  const records: ReadingRecord[] = []
  for (const r of data.reading as Partial<ReadingRecord>[]) {
    const workId = typeof r.workId === 'string' ? ids.get(r.workId) : undefined
    if (!workId || typeof r.chapter !== 'number') continue
    records.push({
      workId,
      chapter: r.chapter,
      status: r.status === 'read' ? 'read' : 'reading',
      progress: typeof r.progress === 'number' ? Math.min(1, Math.max(0, r.progress)) : null,
      url: typeof r.url === 'string' ? r.url : '',
      title: typeof r.title === 'string' ? r.title : '',
      source: r.source === 'browser' || r.source === 'history' || r.source === 'app' ? r.source : 'manual',
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now()
    })
  }
  mergeRecords(records)
  return { works: ids.size, chapters: records.length }
}
