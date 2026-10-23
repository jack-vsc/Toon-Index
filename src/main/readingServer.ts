import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ReadingReport } from '../shared/reading'
import { deviceFor, pair, phonesEnabled } from './devices'
import { listLibrary, listWorks, readCover, readLibraryPdf } from './library'
import { unreadUpdates } from '../shared/updates'
import { displayName } from '../shared/works'
import { updatesStatus } from './updates'
import { addLinkJob, addPdfJob, cancelRemoteJob, listRemoteJobs } from './remoteJobs'
import { finishedInApp, forgetReading, listReading, markRead, readInApp, reportReading } from './reading'

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
    return send(res, 200, { works: listWorks(), reading: listReading(), chapters, updates: newChapters(), ntfyTopic: updatesStatus().ntfyTopic })
  }
  const cover = /^\/api\/cover\/([a-f0-9-]+)$/i.exec(path)
  if (req.method === 'GET' && cover) {
    const jpeg = readCover(cover[1])
    return jpeg ? sendBytes(res, 'image/jpeg', jpeg) : send(res, 404, { error: 'Sem capa.' })
  }
  const pdf = /^\/api\/pdf\/([a-f0-9-]+)\/(original|translated)$/i.exec(path)
  if (req.method === 'GET' && pdf) {
    const bytes = await readLibraryPdf(pdf[1], pdf[2] as 'original' | 'translated').catch(() => null)
    return bytes ? sendBytes(res, 'application/pdf', Buffer.from(bytes)) : send(res, 404, { error: 'Capítulo não encontrado no PC.' })
  }
  // Chapters to translate on the PC: a site's link, or a PDF sent as the request's body.
  if (req.method === 'GET' && path === '/api/translate') return send(res, 200, listRemoteJobs())
  if (req.method === 'POST' && path === '/api/translate') {
    const { url: link } = (await readBody(req)) as { url?: unknown }
    if (typeof link !== 'string') return send(res, 400, { error: 'Falta o link.' })
    try {
      return send(res, 200, addLinkJob(link.trim(), device.name))
    } catch (err) {
      return send(res, 400, { error: err instanceof TypeError ? 'Link inválido.' : (err as Error).message })
    }
  }
  if (req.method === 'POST' && path === '/api/translate/pdf') {
    try {
      return send(res, 200, addPdfJob(url.searchParams.get('name') ?? '', await readRaw(req, MAX_PDF), device.name))
    } catch (err) {
      return send(res, 400, { error: (err as Error).message })
    }
  }
  if (req.method === 'POST' && path === '/api/translate/cancel') {
    const { id } = (await readBody(req)) as { id?: unknown }
    if (typeof id === 'string') cancelRemoteJob(id)
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
  if (req.method === 'POST' && path === '/api/reading/mark') {
    const { workId, chapter } = (await readBody(req)) as { workId: string; chapter: number }
    if (typeof workId !== 'string' || typeof chapter !== 'number') return send(res, 400, { error: 'workId e chapter.' })
    markRead(workId, chapter)
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && path === '/api/reading/forget') {
    const { workId, chapter } = (await readBody(req)) as { workId: string; chapter: number | null }
    forgetReading(workId, chapter ?? null)
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

function sendBytes(res: ServerResponse, type: string, bytes: Buffer): void {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length })
  res.end(bytes)
}
