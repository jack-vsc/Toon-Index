import { unreadUpdates } from '../shared/updates'
import { displayName, findWork, isNovelUrl, parseChapterName, SHELVES, shelfOf, type Shelf, type Work } from '../shared/works'
import { addWorkSource, indexWork, listLibrary, listWorks, setWorkShelf } from './library'
import { listReading } from './reading'
import { updatesStatus } from './updates'

/** What the extension's popup shows of the page open: the work it is about, and where it stands. */
export interface PageInfo {
  /** Null when the page names something not in the library yet. */
  workId: string | null
  name: string
  chapter: number | null
  shelf: Shelf | null
  favorite: boolean
  readUpTo: number | null
  /** Chapters of it in the library (translated or downloaded). */
  inLibrary: number
}

/** A work to go back to, for the popup's "Continuar lendo". */
export interface ContinueItem {
  workId: string
  name: string
  shelf: Shelf | null
  favorite: boolean
  /** The chapter left midway, or the last one read. */
  chapter: number
  url: string
  /** A chapter out past the last one read. */
  latest: { chapter: number; url: string } | null
  at: number
}

const bare = (url: string): string => url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()

/** The work a page is about: one of its site pages (or a chapter under one), or the work its title names. */
function workOf(url: string, title: string): { work: Work | null; name: string; chapter: number | null } {
  const parsed = parseChapterName(title, url)
  const works = listWorks()
  const page = bare(url)
  const bySource = works.find((w) => (w.sources ?? []).some((s) => page.startsWith(bare(s))))
  const byName = parsed.work ? findWork(works, parsed.work, isNovelUrl(url) ? 'novel' : 'comic') : null
  const work = bySource ?? byName
  return { work, name: work ? displayName(work.names[0]) : parsed.work, chapter: parsed.chapter }
}

export function pageInfo(url: string, title: string): PageInfo {
  const { work, name, chapter } = workOf(url, title)
  const records = work ? listReading().filter((r) => r.workId === work.id) : []
  const read = records.filter((r) => r.status === 'read').map((r) => r.chapter)
  return {
    workId: work?.id ?? null,
    name,
    chapter,
    shelf: work ? shelfOf(work, records.length > 0) : null,
    favorite: !!work?.favorite,
    readUpTo: read.length ? Math.max(...read) : null,
    inLibrary: work ? listLibrary().filter((e) => e.workId === work.id).length : 0
  }
}

/**
 * Puts the page's work on a reading list or among the favorites, adding it to the library when it is
 * new. A work's own page (not a chapter) becomes one of its sites, checked for new chapters.
 */
export function bookmarkPage(url: string, title: string, patch: { shelf?: unknown; favorite?: unknown }): PageInfo {
  const { work, name, chapter } = workOf(url, title)
  if (!work && !name) throw new Error('Não deu para saber o nome da obra nesta página.')
  const workId = work?.id ?? indexWork(name, isNovelUrl(url) ? 'novel' : 'comic')
  if (chapter === null) addWorkSource(listWorks().find((w) => w.id === workId)!.names[0], url)
  const shelf = patch.shelf === null || (typeof patch.shelf === 'string' && patch.shelf in SHELVES) ? (patch.shelf as Shelf | null) : undefined
  setWorkShelf(workId, { shelf, ...(typeof patch.favorite === 'boolean' && { favorite: patch.favorite }) })
  return pageInfo(url, title)
}

/** The works being read, the favorites first, then the latest read; with what came out since. */
export function continueList(limit = 15): ContinueItem[] {
  const reading = listReading()
  const fresh = new Map(unreadUpdates(updatesStatus().updates, reading).map((u) => [u.workId, u]))
  const items: ContinueItem[] = []
  for (const work of listWorks()) {
    const records = reading.filter((r) => r.workId === work.id)
    const shelf = shelfOf(work, records.length > 0)
    if (!records.length || shelf === 'done' || shelf === 'dropped') continue
    const read = records.filter((r) => r.status === 'read').map((r) => r.chapter)
    const upTo = read.length ? Math.max(...read) : -Infinity
    const current = records.filter((r) => r.status === 'reading' && r.chapter > upTo).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const last = current ?? records.filter((r) => r.url).sort((a, b) => b.chapter - a.chapter)[0]
    if (!last?.url) continue
    const update = fresh.get(work.id)
    items.push({
      workId: work.id,
      name: displayName(work.names[0]),
      shelf,
      favorite: !!work.favorite,
      chapter: last.chapter,
      url: last.url,
      latest: update ? { chapter: update.latest, url: update.url } : null,
      at: Math.max(...records.map((r) => r.updatedAt))
    })
  }
  return items.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.at - a.at).slice(0, limit)
}
