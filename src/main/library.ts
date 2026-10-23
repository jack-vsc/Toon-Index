import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryEntry, SaveLibraryInput } from '../shared/types'
import { findWork, normalizeName, parseChapterName, withName, type Work } from '../shared/works'
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
export function indexWork(name: string): string {
  const works = listWorks()
  const clean = name.trim() || 'Sem nome'
  const found = findWork(works, clean)
  if (found) {
    saveWorks(works.map((w) => (w.id === found.id ? withName(w, clean) : w)))
    return found.id
  }
  const work: Work = { id: randomUUID(), names: [clean], createdAt: Date.now() }
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
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    model: currentModelLabel(),
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
  const works = listWorks().map((w) =>
    w.id === workId ? { ...w, names: clean } : { ...w, names: w.names.filter((n) => !keys.has(normalizeName(n))) }
  )
  saveWorks(works)
  return works
}

/** Moves every chapter of `fromId` into `intoId`, which also takes all its names. */
export function mergeWorks(intoId: string, fromId: string): Work[] {
  if (intoId === fromId) return listWorks()
  for (const entry of listLibrary()) if (entry.workId === fromId) writeMeta({ ...readMeta(entry.id), workId: intoId })
  const works = listWorks()
  const from = works.find((w) => w.id === fromId)
  const merged = works
    .filter((w) => w.id !== fromId)
    .map((w) => (w.id === intoId && from ? from.names.reduce(withName, w) : w))
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
  // The name now points at the work it was moved to, not the one it was wrongly put in.
  const key = normalizeName(found)
  works = works.map((w) => (w.id === workId ? withName(w, found) : { ...w, names: w.names.filter((n) => normalizeName(n) !== key || w.names.length === 1) }))
  saveWorks(works)
  writeMeta({ ...meta, workId })
  return works
}

export async function readLibraryPdf(id: string, which: 'original' | 'translated'): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(entryDir(id), `${which}.pdf`)))
}

export function deleteFromLibrary(id: string): void {
  rmSync(entryDir(id), { recursive: true, force: true })
}
