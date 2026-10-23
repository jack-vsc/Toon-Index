import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ReadingReport } from '../shared/reading'
import { deviceFor, pair, phonesEnabled } from './devices'
import { listLibrary, listWorks, readCover, readLibraryPdf } from './library'
import { finishedInApp, forgetReading, listReading, markRead, reportReading } from './reading'

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
  if (req.method === 'POST' && path === '/reading') return send(res, 200, report(await readBody(req)))
  send(res, 404, { error: 'Não encontrado.' })
}

/** The phone app's API. Everything but pairing needs the token the phone got when it paired. */
async function phone(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
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
    return send(res, 200, { works: listWorks(), reading: listReading(), chapters })
  }
  const cover = /^\/api\/cover\/([a-f0-9-]+)$/i.exec(path)
  if (req.method === 'GET' && cover) {
    const jpeg = readCover(cover[1])
    return jpeg ? sendBytes(res, 'image/jpeg', jpeg) : send(res, 404, { error: 'Sem capa.' })
  }
  const pdf = /^\/api\/pdf\/([a-f0-9-]+)\/(original|translated)$/i.exec(path)
  if (req.method === 'GET' && pdf) {
    return sendBytes(res, 'application/pdf', Buffer.from(await readLibraryPdf(pdf[1], pdf[2] as 'original' | 'translated')))
  }
  if (req.method === 'POST' && path === '/api/reading') return send(res, 200, report(await readBody(req)))
  if (req.method === 'POST' && path === '/api/reading/finished') {
    const { entryId } = (await readBody(req)) as { entryId: string }
    finishedInApp(entryId)
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
