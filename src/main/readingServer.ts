import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ReadingReport } from '../shared/reading'
import { reportReading } from './reading'

/** The browser extension (extension/background.js) sends the chapters being read here. */
export const READING_PORT = 47321

let server: Server | null = null

/**
 * Listens on this computer only, and answers browser extensions only: a web page cannot send a
 * request with an extension's Origin, so no site can mark chapters read.
 */
export function startReadingServer(): void {
  server = createServer((req, res) => {
    const origin = req.headers.origin ?? ''
    if (!/^(chrome|moz)-extension:\/\//.test(origin)) return send(res, 403, { error: 'Somente a extensão do Manga Index.' })
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST')
    if (req.method === 'OPTIONS') return send(res, 204)
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, { app: 'Manga Index' })
    if (req.method === 'POST' && req.url === '/reading') {
      readBody(req)
        .then((body) => {
          // A single report, or the ones the extension kept while the app was closed.
          const reports = (Array.isArray(body) ? body : [body]) as ReadingReport[]
          const results = reports.filter(valid).map((r) => reportReading(r))
          send(res, 200, results[results.length - 1] ?? null)
        })
        .catch((err: Error) => send(res, 400, { error: err.message }))
      return
    }
    send(res, 404, { error: 'Não encontrado.' })
  })
  // Another copy of the app already listening keeps the reports; this one just goes without.
  server.on('error', (err) => console.warn('[reading] server not started:', err.message))
  server.listen(READING_PORT, '127.0.0.1')
}

export function stopReadingServer(): void {
  server?.close()
  server = null
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
        resolve(JSON.parse(body))
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
