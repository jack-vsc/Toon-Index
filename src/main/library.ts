import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryEntry, SaveLibraryInput } from '../shared/types'
import { getSettings } from './settings'
import { currentModelLabel } from './translate'

type StoredEntry = Omit<LibraryEntry, 'cover'>

const root = (): string => join(app.getPath('userData'), 'library')
const entryDir = (id: string): string => {
  if (!/^[a-f0-9-]+$/i.test(id)) throw new Error('ID inválido')
  return join(root(), id)
}

export function listLibrary(): LibraryEntry[] {
  if (!existsSync(root())) return []
  const entries: LibraryEntry[] = []
  for (const id of readdirSync(root())) {
    const dir = join(root(), id)
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as StoredEntry
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

  const meta: StoredEntry = {
    id,
    title: input.fileName.replace(/\.pdf$/i, ''),
    fileName: input.fileName,
    createdAt: Date.now(),
    pageCount: input.pageCount,
    translatedPages: input.translatedPages,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    model: currentModelLabel()
  }
  // Written last so a half-saved entry never shows up in the list.
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  return { ...meta, cover: `data:image/jpeg;base64,${Buffer.from(input.coverJpeg).toString('base64')}` }
}

export async function readLibraryPdf(id: string, which: 'original' | 'translated'): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(entryDir(id), `${which}.pdf`)))
}

export function deleteFromLibrary(id: string): void {
  rmSync(entryDir(id), { recursive: true, force: true })
}
