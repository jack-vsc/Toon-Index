import { app } from 'electron'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ReadingReport } from '../shared/reading'
import { deviceFor, pair, phonesEnabled } from './devices'
import { addWorkSource, deleteFromLibrary, hasWorkCover, listLibrary, listWorks, readCover, readLibraryPdf, readWorkCover, setWorkShelf } from './library'
import { displayName, findWork, SHELVES, type Shelf } from '../shared/works'
import { unreadUpdates, type ChapterLink } from '../shared/updates'
import { CATALOG_SITES, type CatalogSite } from '../shared/catalog'
import { chapterList, searchCatalogToChoose } from './catalog'
import { updatesStatus } from './updates'
import { bookmarkPage, continueList, pageInfo } from './extensionApi'
import {
  addBatch,
  addLinkJob,
  addPdfJob,
  cancelRemoteJob,
  cleanOptions,
  listRemoteJobs,
  pauseRemoteJobs,
  remoteQueue,
  reorderQueue,
  retryBatch,
  setQueueOptions,
  sortQueue
} from './remoteJobs'
import { getPublicSettings, saveTranslateDefaults } from './settings'
import { AUTO_LANGUAGE, isLocalProfile, LANGUAGES, profileReady, TRANSLATE_OPTION_KEYS } from '../shared/types'
import { finishedInApp, forgetReading, libraryChangedElsewhere, listReading, markRead, readInApp, reportReading } from './reading'
import { mergeData, resolveWork } from './dataSync'

/** The browser extension (extension/background.js) and the phone app reach the app here. */
export const READING_PORT = 47321

let server: Server | null = null

/**
 * Two kinds of callers:
 * - the browser extension, on this computer only: a web page cannot send a request with an
 *   extension's Origin, so no site can mark chapters read;
 * - paired phones, on the home network or Tailscale when turned on in the app, each with its token.
 */
export function startReadingServer(): void {
  server = createServer((req, res) => {
    route(req, res).catch((err: Error) => send(res, 500, { error: err.message }))
  })
  // Another copy of the app already listening keeps the reports; this one just goes without.
  server.on('error', (err) => console.warn('[reading] server not started:', err.message))
  server.listen(READING_PORT, phonesEnabled() ? '0.0.0.0' : '127.0.0.1')
}

export function stopReadingServer(): void {
  server?.close()
  server = null
}

/** Listens again, on the network or on this computer only, after phones were turned on or off. */
export function restartReadingServer(): void {
  const old = server
  server = null
  if (!old) return startReadingServer()
  old.close(() => startReadingServer())
  // Open connections (a phone waiting on a PDF) would keep the old one from closing.
  old.closeAllConnections()
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://app')
  const path = url.pathname

  if (path.startsWith('/api/')) return phone(req, res, path)

  // The extension.
  const local = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress ?? '')
  const origin = req.headers.origin ?? ''
  if (!local || !/^(chrome|moz)-extension:\/\//.test(origin)) return send(res, 403, { error: 'Somente a extensão do Manga Index.' })
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST')
  if (req.method === 'OPTIONS') return send(res, 204)
  if (req.method === 'GET' && path === '/status') return send(res, 200, { app: 'Manga Index' })
  if (req.method === 'GET' && path === '/updates') return send(res, 200, newChapters())
  if (req.method === 'POST' && path === '/reading') return send(res, 200, report(await readBody(req)))
  // The popup: the page's work, putting it on a list, and the works to go back to.
  if (req.method === 'GET' && path === '/continue') return send(res, 200, continueList())
  if (req.method === 'POST' && (path === '/page' || path === '/bookmark')) {
    const body = (await readBody(req)) as { url?: unknown; title?: unknown; shelf?: unknown; favorite?: unknown }
    if (typeof body?.url !== 'string' || typeof body.title !== 'string') return send(res, 400, { error: 'url e title.' })
    try {
      return send(res, 200, path === '/page' ? pageInfo(body.url, body.title) : bookmarkPage(body.url, body.title, body))
    } catch (err) {
      return send(res, 400, { error: (err as Error).message })
    }
  }
  send(res, 404, { error: 'Não encontrado.' })
}

/** The phone app's API. Everything but pairing needs the token the phone got when it paired. */
async function phone(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://app')
  if (req.method === 'POST' && path === '/api/pair') {
    const body = (await readBody(req)) as { code?: unknown; name?: unknown }
    const paired = typeof body.code === 'string' ? pair(body.code, typeof body.name === 'string' ? body.name : '') : null
    return paired ? send(res, 200, paired) : send(res, 401, { error: 'Código errado ou vencido. Gere outro no app do PC.' })
  }

  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
  const device = token ? deviceFor(token) : null
  if (!device) return send(res, 401, { error: 'Este celular não está pareado (ou foi removido no app do PC).' })

  if (req.method === 'GET' && path === '/api/status') return send(res, 200, { app: 'Manga Index', device })
  if (req.method === 'GET' && path === '/api/library') {
    // Covers go one by one (/api/cover/…), so the list stays small.
    const chapters = listLibrary().map(({ cover, ...entry }) => ({ ...entry, hasCover: !!cover }))
    // The newest chapter out on each work's sites too, for how far along the reading is.
    const out = updatesStatus().updates
    const works = listWorks().map((w) => ({ ...w, hasCover: hasWorkCover(w.id), latest: out[w.id]?.latest ?? null }))
    return send(res, 200, { works, reading: listReading(), chapters, updates: newChapters(), ntfyTopic: updatesStatus().ntfyTopic })
  }
  // The newest phone app (scripts/phone-release.mjs): phones on an older build offer to update.
  if (req.method === 'GET' && path === '/api/app') {
    const release = phoneRelease()
    return release ? send(res, 200, { version: release.version, build: release.build }) : send(res, 404, { error: 'Nenhum APK no PC.' })
  }
  if (req.method === 'GET' && path === '/api/app/apk') {
    const release = phoneRelease()
    if (!release) return send(res, 404, { error: 'Nenhum APK no PC.' })
    res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': statSync(release.file).size })
    createReadStream(release.file).pipe(res)
    return
  }
  const cover = /^\/api\/cover\/([a-f0-9-]+)$/i.exec(path)
  if (req.method === 'GET' && cover) {
    const jpeg = readCover(cover[1])
    return jpeg ? sendBytes(res, 'image/jpeg', jpeg) : send(res, 404, { error: 'Sem capa.' })
  }
  const workCover = /^\/api\/work-cover\/([a-f0-9-]+)$/i.exec(path)
  if (req.method === 'GET' && workCover) {
    const jpeg = readWorkCover(workCover[1])
    return jpeg ? sendBytes(res, 'image/jpeg', jpeg) : send(res, 404, { error: 'Sem capa.' })
  }
  const pdf = /^\/api\/pdf\/([a-f0-9-]+)\/(original|translated)$/i.exec(path)
  if (req.method === 'GET' && pdf) {
    const bytes = await readLibraryPdf(pdf[1], pdf[2] as 'original' | 'translated').catch(() => null)
    return bytes ? sendBytes(res, 'application/pdf', Buffer.from(bytes)) : send(res, 404, { error: 'Capítulo não encontrado no PC.' })
  }
  // Chapters to translate on the PC: a site's link, or a PDF sent as the request's body.
  if (req.method === 'GET' && path === '/api/translate') return send(res, 200, listRemoteJobs())
  // The queue as it will run, and changing it from the phone as from the PC's queue window.
  if (req.method === 'GET' && path === '/api/queue') return send(res, 200, remoteQueue())
  if (req.method === 'POST' && path.startsWith('/api/queue/')) {
    const { ids, paused, options } = (await readBody(req)) as { ids?: unknown; paused?: unknown; options?: unknown }
    const list = Array.isArray(ids) && ids.every((i) => typeof i === 'string') ? (ids as string[]) : undefined
    if (path === '/api/queue/reorder' && list) return send(res, 200, reorderQueue(list))
    // The whole queue (or these) translated with other options; null: with the PC's settings again.
    if (path === '/api/queue/options') return send(res, 200, setQueueOptions(cleanOptions(options), list))
    if (path === '/api/queue/sort') return send(res, 200, sortQueue())
    if (path === '/api/queue/retry') return send(res, 200, retryBatch(list))
    if (path === '/api/queue/pause' && typeof paused === 'boolean') return send(res, 200, pauseRemoteJobs(paused))
    return send(res, 400, { error: 'Pedido da fila inválido.' })
  }
  // The PC's translation settings, to choose from on the phone (its APIs, languages…), and saving them as its defaults.
  if (req.method === 'GET' && path === '/api/translate/options') {
    const s = getPublicSettings()
    return send(res, 200, {
      defaults: Object.fromEntries(TRANSLATE_OPTION_KEYS.map((k) => [k, s[k]])),
      profiles: s.profiles.map((p) => ({ id: p.id, name: p.name, model: p.model, ready: profileReady(p, s.hasKey), local: isLocalProfile(p) })),
      languages: LANGUAGES,
      auto: AUTO_LANGUAGE
    })
  }
  if (req.method === 'POST' && path === '/api/translate/options') {
    const options = cleanOptions(((await readBody(req)) as { options?: unknown }).options)
    if (options) saveTranslateDefaults(options)
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && path === '/api/translate') {
    const { url: link, options } = (await readBody(req)) as { url?: unknown; options?: unknown }
    if (typeof link !== 'string') return send(res, 400, { error: 'Falta o link.' })
    try {
      return send(res, 200, addLinkJob(link.trim(), device.name, cleanOptions(options)))
    } catch (err) {
      return send(res, 400, { error: err instanceof TypeError ? 'Link inválido.' : (err as Error).message })
    }
  }
  // A chapter already in Portuguese, saved as it is in the library (the phone's "Baixar").
  if (req.method === 'POST' && path === '/api/download') {
    const { url: link, work, chapter, site } = (await readBody(req)) as { url?: unknown; work?: unknown; chapter?: unknown; site?: unknown }
    if (typeof link !== 'string' || typeof work !== 'string' || typeof chapter !== 'number') {
      return send(res, 400, { error: 'Falta o link, a obra ou o capítulo.' })
    }
    try {
      new URL(link)
      const host = typeof site === 'string' && site ? site : new URL(link).hostname
      return send(res, 200, addBatch(work, host, [{ chapter, url: link.trim() }], true, device.name))
    } catch (err) {
      return send(res, 400, { error: err instanceof TypeError ? 'Link inválido.' : (err as Error).message })
    }
  }
  // "Vários capítulos" from the phone: the work looked up on the sites, its chapters, and a range of them
  // queued (translated, or downloaded as they are).
  if (req.method === 'POST' && path === '/api/works/search') {
    const { query } = (await readBody(req)) as { query?: unknown }
    if (typeof query !== 'string' || !query.trim()) return send(res, 400, { error: 'Falta o nome da obra.' })
    return send(res, 200, await searchCatalogToChoose(query))
  }
  if (req.method === 'POST' && path === '/api/works/chapters') {
    const { site, url: page, withTitle } = (await readBody(req)) as { site?: unknown; url?: unknown; withTitle?: unknown }
    if (typeof page !== 'string' || (site !== 'link' && !(typeof site === 'string' && site in CATALOG_SITES))) {
      return send(res, 400, { error: 'Falta o site ou o link da obra.' })
    }
    try {
      const found = await chapterList({ site: site as CatalogSite | 'link', url: page })
      // Phones before 1.5 take the list alone.
      return send(res, 200, withTitle ? found : found.chapters)
    } catch (err) {
      return send(res, 400, { error: (err as Error).message })
    }
  }
  if (req.method === 'POST' && path === '/api/batch') {
    const { work, site, chapters, download, source, options } = (await readBody(req)) as {
      work?: unknown
      site?: unknown
      chapters?: unknown
      download?: unknown
      source?: unknown
      options?: unknown
    }
    const valid = Array.isArray(chapters) && chapters.every((c) => typeof c?.chapter === 'number' && typeof c?.url === 'string')
    if (typeof work !== 'string' || !work.trim() || typeof site !== 'string' || !valid) {
      return send(res, 400, { error: 'Falta a obra, o site ou os capítulos.' })
    }
    const queue = addBatch(work, site, chapters as ChapterLink[], download === true, device.name, cleanOptions(options))
    if (typeof source === 'string') addWorkSource(work, source)
    return send(res, 200, queue)
  }
  if (req.method === 'POST' && path === '/api/translate/pdf') {
    try {
      // The body is the PDF: the options come in the address, as JSON.
      let options: unknown = null
      try {
        options = JSON.parse(url.searchParams.get('options') ?? 'null')
      } catch {
        // Sent by a phone that knows no options.
      }
      return send(res, 200, addPdfJob(url.searchParams.get('name') ?? '', await readRaw(req, MAX_PDF), device.name, cleanOptions(options)))
    } catch (err) {
      return send(res, 400, { error: (err as Error).message })
    }
  }
  if (req.method === 'POST' && path === '/api/translate/cancel') {
    const { id } = (await readBody(req)) as { id?: unknown }
    if (typeof id === 'string') cancelRemoteJob(id)
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && path === '/api/translate/retry') {
    const { id } = (await readBody(req)) as { id?: unknown }
    if (typeof id === 'string') retryBatch([id])
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && path === '/api/reading') return send(res, 200, report(await readBody(req)))
  if (req.method === 'POST' && path === '/api/reading/finished') {
    const { entryId } = (await readBody(req)) as { entryId: string }
    finishedInApp(entryId)
    return send(res, 200, { ok: true })
  }
  // Chapters read in the phone's reader: one, or the ones kept while the PC could not be reached.
  if (req.method === 'POST' && path === '/api/reading/app') {
    const body = await readBody(req)
    for (const r of (Array.isArray(body) ? body : [body]) as { entryId?: unknown; progress?: unknown; at?: unknown }[]) {
      if (typeof r?.entryId !== 'string' || typeof r.progress !== 'number') continue
      try {
        readInApp(r.entryId, r.progress, typeof r.at === 'number' ? r.at : undefined)
      } catch {
        // The chapter was deleted from the library meanwhile.
      }
    }
    return send(res, 200, { ok: true })
  }
  // Works the phone made on its own come with their name, and are found (or made) by it.
  if (req.method === 'POST' && path === '/api/reading/mark') {
    const { workId, name, chapter } = (await readBody(req)) as { workId?: unknown; name?: unknown; chapter?: unknown }
    const id = resolveWork(workId, name)
    if (!id || typeof chapter !== 'number') return send(res, 400, { error: 'workId e chapter.' })
    markRead(id, chapter)
    return send(res, 200, { ok: true })
  }
  // What the phone has (a backup restored there): merged into the PC's.
  if (req.method === 'POST' && path === '/api/merge') {
    try {
      return send(res, 200, mergeData((await readBody(req)) as { works?: unknown; reading?: unknown }))
    } catch (err) {
      return send(res, 400, { error: (err as Error).message })
    }
  }
  if (req.method === 'POST' && path === '/api/works/shelf') {
    const { workId, name, shelf, favorite } = (await readBody(req)) as { workId?: unknown; name?: unknown; shelf?: unknown; favorite?: unknown }
    const id = resolveWork(workId, name)
    if (!id || (shelf !== null && !(typeof shelf === 'string' && shelf in SHELVES))) {
      return send(res, 400, { error: 'workId e shelf.' })
    }
    setWorkShelf(id, { shelf: shelf as Shelf | null, favorite: favorite === true })
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && path === '/api/library/delete') {
    // One version of a chapter, deleted from the phone.
    const { id } = (await readBody(req)) as { id?: unknown }
    if (typeof id !== 'string' || !/^[a-f0-9-]+$/i.test(id)) return send(res, 400, { error: 'id.' })
    deleteFromLibrary(id)
    libraryChangedElsewhere()
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && path === '/api/reading/forget') {
    const { workId, name, chapter } = (await readBody(req)) as { workId?: unknown; name?: unknown; chapter?: number | null }
    // A work the PC does not know has nothing to forget (nor is it made for that).
    const id = typeof workId === 'string' && listWorks().some((w) => w.id === workId) ? workId : typeof name === 'string' ? findWork(listWorks(), name)?.id : undefined
    if (id) forgetReading(id, chapter ?? null)
    return send(res, 200, { ok: true })
  }
  send(res, 404, { error: 'Não encontrado.' })
}

/** Chapters out on the works' sites past the last one read, with the work's name. */
function newChapters(): (ReturnType<typeof unreadUpdates>[number] & { work: string })[] {
  const works = listWorks()
  return unreadUpdates(updatesStatus().updates, listReading()).map((u) => ({
    ...u,
    work: displayName(works.find((w) => w.id === u.workId)?.names[0] ?? '')
  }))
}

/** A single report, or the ones kept while the app could not be reached; answers with the last one's result. */
function report(body: unknown): unknown {
  const reports = (Array.isArray(body) ? body : [body]) as ReadingReport[]
  const results = reports.filter(valid).map((r) => reportReading(r))
  return results[results.length - 1] ?? null
}

function valid(r: unknown): r is ReadingReport {
  const x = r as ReadingReport
  return !!x && typeof x.url === 'string' && typeof x.title === 'string' && (x.progress === null || typeof x.progress === 'number')
}

/** A chapter's PDF from the phone; scans of a long chapter run to tens of megabytes. */
const MAX_PDF = 300 * 1024 * 1024

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) req.destroy(new Error('Arquivo grande demais.'))
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy(new Error('Grande demais.'))
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        reject(new Error('JSON inválido.'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

/** The phone app the PC hands out, when one was built here. */
function phoneRelease(): { version: string; build: number; file: string } | null {
  const folder = app.isPackaged ? join(process.resourcesPath, 'phone') : join(app.getAppPath(), 'mobile', 'build')
  try {
    const { version, build } = JSON.parse(readFileSync(join(folder, 'MangaIndex.json'), 'utf8')) as { version: string; build: number }
    const file = join(folder, 'MangaIndex.apk')
    return existsSync(file) ? { version, build, file } : null
  } catch {
    return null
  }
}

function sendBytes(res: ServerResponse, type: string, bytes: Buffer): void {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length })
  res.end(bytes)
}
