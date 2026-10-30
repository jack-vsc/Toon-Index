import { app, session } from 'electron'
import { existsSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import type { StorageArea, StorageUsage } from '../shared/storage'
import { clearLayers, layersDir } from './layers'
import { deleteFromLibrary, listWorks, readMeta } from './library'
import { libraryChangedElsewhere } from './reading'

/**
 * How much of the disk the app takes, by what it is (the works' chapters, the translation layers, the
 * AI's answers, the window's caches…), and clearing what can be had again.
 */

const userData = (): string => app.getPath('userData')
const libraryRoot = (): string => join(userData(), 'library')
const AI_CACHE = 'translation-cache'
/** The window's own caches (Chromium): made again as it is used. */
const APP_CACHES = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'GPUPersistentCache']

/** Bytes and files under a path (a file or a folder, followed all the way down). */
function measure(path: string): { bytes: number; files: number } {
  if (!existsSync(path)) return { bytes: 0, files: 0 }
  const stat = statSync(path)
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 }
  let bytes = 0
  let files = 0
  for (const name of readdirSync(path)) {
    const inner = measure(join(path, name))
    bytes += inner.bytes
    files += inner.files
  }
  return { bytes, files }
}

const sizeOf = (path: string): number => (existsSync(path) ? statSync(path).size : 0)

export function storageUsage(): StorageUsage {
  const names = new Map(listWorks().map((w) => [w.id, w.names[0]]))
  const works = new Map<string, StorageUsage['works'][number]>()
  if (existsSync(libraryRoot())) {
    for (const id of readdirSync(libraryRoot())) {
      const dir = join(libraryRoot(), id)
      if (!existsSync(join(dir, 'meta.json'))) continue
      let workId: string
      try {
        workId = readMeta(id).workId
      } catch {
        continue
      }
      const work = works.get(workId) ?? { workId, name: names.get(workId) ?? 'Sem obra', chapters: 0, translated: 0, original: 0, other: 0 }
      const translated = sizeOf(join(dir, 'translated.pdf'))
      const original = sizeOf(join(dir, 'original.pdf'))
      work.chapters++
      work.translated += translated
      work.original += original
      work.other += measure(dir).bytes - translated - original
      works.set(workId, work)
    }
  }
  const areas: StorageUsage['areas'] = {
    layers: measure(layersDir()),
    aiCache: measure(join(userData(), AI_CACHE)),
    appCache: APP_CACHES.map((name) => measure(join(userData(), name))).reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files })),
    models: measure(join(userData(), 'models')),
    phoneUploads: measure(join(userData(), 'remote-jobs'))
  }
  const listed = [...works.values()].sort((a, b) => b.translated + b.original + b.other - (a.translated + a.original + a.other))
  const total =
    listed.reduce((sum, w) => sum + w.translated + w.original + w.other, 0) + Object.values(areas).reduce((sum, a) => sum + a.bytes, 0)
  let free: number | null = null
  try {
    const fs = statfsSync(userData())
    free = fs.bavail * fs.bsize
  } catch {
    // Unknown on this system.
  }
  return { works: listed, areas, total, free }
}

/** Clears what is made again when needed: the translation layers, the AI's answers or the window's caches. */
export async function clearArea(area: StorageArea): Promise<StorageUsage> {
  if (area === 'layers') clearLayers()
  if (area === 'aiCache') rmSync(join(userData(), AI_CACHE), { recursive: true, force: true })
  if (area === 'appCache') {
    // The running window holds some of these open; Chromium empties them itself.
    await session.defaultSession.clearCache()
    await session.defaultSession.clearCodeCaches({}).catch(() => undefined)
  }
  return storageUsage()
}

/**
 * Every chapter of a work saved on this PC deleted (its PDFs); its readings stay, and so do its
 * translation layers, so translating a chapter again takes moments.
 */
export function deleteWorkChapters(workId: string): StorageUsage {
  if (existsSync(libraryRoot())) {
    for (const id of readdirSync(libraryRoot())) {
      try {
        if (readMeta(id).workId === workId) deleteFromLibrary(id)
      } catch {
        // Not a chapter.
      }
    }
  }
  libraryChangedElsewhere()
  return storageUsage()
}
