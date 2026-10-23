import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CatalogSite } from '../shared/catalog'
import { DOWNLOADED_MODEL, type LibraryEntry, type SaveLibraryInput } from '../shared/types'
import { MAX_SOURCES } from '../shared/updates'
import { findWork, formatOf, normalizeName, parseChapterName, withName, type Work, type WorkFormat } from '../shared/works'
import { moveReading } from './reading'
import { getSettings } from './settings'
import { currentModelLabel } from './translate'

type StoredEntry = Omit<LibraryEntry, 'cover'>

const root = (): string => join(app.getPath('userData'), 'library')
/** Every work ever indexed, with the names it was seen under; kept when its last chapter goes, to recognize it later. */
const worksPath = (): string => join(root(), 'works.json')
const entryDir = (id: string): string => {
  if (!/^[a-f0-9-]+$/i.test(id)) throw new Error('ID inválido')
  return join(root(), id)
}

export function listWorks(): Work[] {
  try {
    return (JSON.parse(readFileSync(worksPath(), 'utf8')) as { works: Work[] }).works
  } catch {
    return []
  }
}

function saveWorks(works: Work[]): void {
  mkdirSync(root(), { recursive: true })
  writeFileSync(worksPath(), JSON.stringify({ works }, null, 2))
}

/** The work a chapter named `name` belongs to, created when no known name matches; learns the name. */
export function indexWork(name: string, format: WorkFormat = 'comic'): string {
  const works = listWorks()
  const clean = name.trim() || 'Sem nome'
  const found = findWork(works, clean, format)
  if (found) {
    saveWorks(works.map((w) => (w.id === found.id ? withName(w, clean) : w)))
    return found.id
  }
  const work: Work = { id: randomUUID(), names: [clean], createdAt: Date.now(), ...(format === 'novel' && { format }) }
  saveWorks([...works, work])
  return work.id
}

export function readMeta(id: string): StoredEntry {
  return JSON.parse(readFileSync(join(entryDir(id), 'meta.json'), 'utf8')) as StoredEntry
}

function writeMeta(meta: StoredEntry): void {
  writeFileSync(join(entryDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2))
}

export function listLibrary(): LibraryEntry[] {
  if (!existsSync(root())) return []
  const entries: LibraryEntry[] = []
  for (const id of readdirSync(root())) {
    const dir = join(root(), id)
    if (!existsSync(join(dir, 'meta.json'))) continue
    try {
      let meta = readMeta(id)
      // Chapters saved before works existed are indexed the first time they are listed.
      if (!meta.workId) {
        const parsed = parseChapterName(meta.fileName, meta.source)
        meta = { ...meta, workId: indexWork(parsed.work), chapter: parsed.chapter }
        writeMeta(meta)
      }
      const coverPath = join(dir, 'cover.jpg')
      const cover = existsSync(coverPath) ? `data:image/jpeg;base64,${readFileSync(coverPath).toString('base64')}` : ''
      entries.push({ ...meta, cover })
    } catch {
      // Incomplete entry (e.g. app closed mid-save); ignore it.
    }
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt)
}

export function saveToLibrary(input: SaveLibraryInput): LibraryEntry {
  const settings = getSettings()
  const id = randomUUID()
  const dir = entryDir(id)
  mkdirSync(dir, { recursive: true })

  writeFileSync(join(dir, 'original.pdf'), input.original)
  writeFileSync(join(dir, 'translated.pdf'), input.translated)
  writeFileSync(join(dir, 'cover.jpg'), input.coverJpeg)

  const parsed = parseChapterName(input.fileName, input.source)
  const meta: StoredEntry = {
    id,
    title: input.fileName.replace(/\.pdf$/i, ''),
    fileName: input.fileName,
    createdAt: Date.now(),
    pageCount: input.pageCount,
    translatedPages: input.translatedPages,
    sourceLanguage: input.downloaded ? settings.targetLanguage : settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    model: input.downloaded ? DOWNLOADED_MODEL : currentModelLabel(),
    workId: indexWork(parsed.work),
    chapter: parsed.chapter,
    ...(input.source ? { source: input.source } : {})
  }
  // Written last so a half-saved entry never shows up in the list.
  writeMeta(meta)
  return { ...meta, cover: `data:image/jpeg;base64,${Buffer.from(input.coverJpeg).toString('base64')}` }
}

/** Replaces a work's names (the first is shown); a name another work had moves to this one. */
export function setWorkNames(workId: string, names: string[]): Work[] {
  const clean = [...new Map(names.map((n) => n.trim()).filter(Boolean).map((n) => [normalizeName(n), n])).values()]
  if (!clean.length) throw new Error('A obra precisa de pelo menos um nome.')
  const keys = new Set(clean.map(normalizeName))
  const all = listWorks()
  const format = formatOf(all.find((w) => w.id === workId)!)
  // The novel keeps the names it shares with its manga.
  const works = all.map((w) =>
    w.id === workId
      ? { ...w, names: clean }
      : formatOf(w) === format
        ? { ...w, names: w.names.filter((n) => !keys.has(normalizeName(n))) }
        : w
  )
  saveWorks(works)
  return works
}

/** A work's own cover, from the catalog sites; the library shows its latest chapter's otherwise. */
const workCoverPath = (workId: string): string => {
  if (!/^[a-f0-9-]+$/i.test(workId)) throw new Error('ID inválido')
  return join(root(), 'work-covers', `${workId}.jpg`)
}

export function readWorkCover(workId: string): Buffer | null {
  const path = workCoverPath(workId)
  return existsSync(path) ? readFileSync(path) : null
}

/** By work id, the covers of works that have one, as data URLs for the library. */
export function workCovers(): Record<string, string> {
  const covers: Record<string, string> = {}
  for (const work of listWorks()) {
    const jpeg = readWorkCover(work.id)
    if (jpeg) covers[work.id] = `data:image/jpeg;base64,${jpeg.toString('base64')}`
  }
  return covers
}

/**
 * What the catalog sites know of a work: names no other work of its kind has, its pages there (after the
 * ones set by hand, up to the limit) and a cover. Notes the lookup either way.
 */
export function applyCatalog(
  workId: string,
  found: { names: string[]; sources: string[]; sites: CatalogSite[]; cover: Buffer | null }
): Work[] {
  const all = listWorks()
  const work = all.find((w) => w.id === workId)
  if (!work) throw new Error('Obra não encontrada.')
  const taken = new Set(
    all.filter((w) => w.id !== workId && formatOf(w) === formatOf(work)).flatMap((w) => w.names.map(normalizeName))
  )
  // Very short names ("Item") would catch chapters of other works.
  const names = found.names.filter((n) => normalizeName(n).length >= 4 && !taken.has(normalizeName(n)))
  const sources = [...new Set([...(work.sources ?? []), ...found.sources])].slice(0, MAX_SOURCES)
  const updated: Work = {
    ...names.reduce(withName, work),
    ...(sources.length && { sources }),
    catalog: { checkedAt: Date.now(), sites: [...new Set([...(work.catalog?.sites ?? []), ...found.sites])] }
  }
  if (found.cover) {
    mkdirSync(join(root(), 'work-covers'), { recursive: true })
    writeFileSync(workCoverPath(workId), found.cover)
  }
  const works = all.map((w) => (w.id === workId ? updated : w))
  saveWorks(works)
  return works
}

/**
 * The work named `name` (made when new) gets `source`, its page on a site, among the ones checked for
 * new chapters: the page a range of its chapters was taken from. It goes first, so it stays when the
 * work already has as many as it can.
 */
export function addWorkSource(name: string, source: string): void {
  const workId = indexWork(name)
  saveWorks(
    listWorks().map((w) =>
      w.id === workId && !w.sources?.includes(source) ? { ...w, sources: [source, ...(w.sources ?? [])].slice(0, MAX_SOURCES) } : w
    )
  )
}

/** The work's pages on sites, checked for new chapters (shared/updates.ts). */
export function saveWorkSources(workId: string, sources: string[]): void {
  saveWorks(listWorks().map((w) => (w.id === workId ? { ...w, sources } : w)))
}

/** Moves every chapter of `fromId` into `intoId`, which also takes all its names (and sites). */
export function mergeWorks(intoId: string, fromId: string): Work[] {
  if (intoId === fromId) return listWorks()
  for (const entry of listLibrary()) if (entry.workId === fromId) writeMeta({ ...readMeta(entry.id), workId: intoId })
  const works = listWorks()
  const from = works.find((w) => w.id === fromId)
  const merged = works
    .filter((w) => w.id !== fromId)
    .map((w) => {
      if (w.id !== intoId || !from) return w
      const sources = [...new Set([...(w.sources ?? []), ...(from.sources ?? [])])].slice(0, MAX_SOURCES)
      return { ...from.names.reduce(withName, w), ...(sources.length && { sources }) }
    })
  saveWorks(merged)
  moveReading(fromId, intoId)
  return merged
}

/**
 * Puts a chapter in another work, or in a new one named `newName`; the work it goes to learns the name
 * the chapter was found under, so the next chapter with that name lands there by itself.
 */
export function moveToWork(entryId: string, target: { workId: string } | { newName: string }): Work[] {
  const meta = readMeta(entryId)
  const found = parseChapterName(meta.fileName, meta.source).work
  let works = listWorks()
  let workId: string
  if ('workId' in target) {
    workId = target.workId
  } else {
    const work: Work = { id: randomUUID(), names: [target.newName.trim() || found], createdAt: Date.now() }
    works = [...works, work]
    workId = work.id
  }
  // The name now points at the work it was moved to, not the one it was wrongly put in (a novel of
  // the same name keeps it: library chapters are comics).
  const key = normalizeName(found)
  works = works.map((w) =>
    w.id === workId
      ? withName(w, found)
      : formatOf(w) === 'novel'
        ? w
        : { ...w, names: w.names.filter((n) => normalizeName(n) !== key || w.names.length === 1) }
  )
  saveWorks(works)
  writeMeta({ ...meta, workId })
  return works
}

export async function readLibraryPdf(id: string, which: 'original' | 'translated'): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(entryDir(id), `${which}.pdf`)))
}

/** The chapter's cover (JPEG), or null when it has none. */
export function readCover(id: string): Buffer | null {
  const path = join(entryDir(id), 'cover.jpg')
  return existsSync(path) ? readFileSync(path) : null
}

export function deleteFromLibrary(id: string): void {
  rmSync(entryDir(id), { recursive: true, force: true })
}
