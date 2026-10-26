import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteJob, RemoteQueue } from '../shared/remoteJobs'

/** Finished ones are kept a while for the phone to see how they went. */
const KEEP_DONE_DAYS = 7

const dir = (): string => join(app.getPath('userData'), 'remote-jobs')
const listPath = (): string => join(dir(), 'jobs.json')
const pdfPath = (id: string): string => join(dir(), `${id}.pdf`)

const listeners = new Set<() => void>()

/** Called when a job is added or changes, so the window can pick it up or show it. */
export function onRemoteJobsChanged(listener: () => void): void {
  listeners.add(listener)
}

export function listRemoteJobs(): RemoteJob[] {
  return remoteQueue().jobs
}

export function remoteQueue(): RemoteQueue {
  try {
    const stored = JSON.parse(readFileSync(listPath(), 'utf8')) as Partial<RemoteQueue>
    const old = Date.now() - KEEP_DONE_DAYS * 86_400_000
    const jobs = (stored.jobs ?? []).filter((j) => j.status === 'queued' || j.status === 'running' || j.updatedAt > old)
    return { jobs, paused: stored.paused === true }
  } catch {
    return { jobs: [], paused: false }
  }
}

function save(jobs: RemoteJob[], paused = remoteQueue().paused): void {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(listPath(), JSON.stringify({ jobs, paused }, null, 2))
  for (const listener of listeners) listener()
}

/** Pausing leaves the queue as it is; the window stops the chapter running and puts it back. */
export function pauseRemoteJobs(paused: boolean): RemoteQueue {
  save(listRemoteJobs(), paused)
  return remoteQueue()
}

/** A range of a work's chapters, translated in order, after whatever is queued already. */
export function addBatch(work: string, site: string, chapters: { chapter: number; url: string }[], download = false, device = 'PC'): RemoteQueue {
  const clean = work.trim()
  if (!clean) throw new Error('Informe o nome da obra.')
  if (!chapters.length) throw new Error('Nenhum capítulo nessa faixa.')
  const now = Date.now()
  const added: RemoteJob[] = chapters.map((c, i) => ({
    id: randomUUID(),
    kind: 'link',
    url: c.url,
    name: `${clean} Chapter ${c.chapter}`,
    device,
    // Apart by a millisecond each, so they keep their order.
    createdAt: now + i,
    updatedAt: now + i,
    status: 'queued',
    batch: { work: clean, chapter: c.chapter, site, ...(download && { download }) }
  }))
  save(inChapterOrder([...listRemoteJobs(), ...added], clean))
  return remoteQueue()
}

/** Takes every queued chapter of the ranges asked for on the PC off the queue. */
export function clearBatch(): RemoteQueue {
  save(listRemoteJobs().filter((j) => !(j.batch && j.status === 'queued')))
  return remoteQueue()
}

/**
 * Chapters that failed go back to the queue: every one of the ranges, or the ones in `ids` (a link the
 * phone sent too; a PDF it sent is gone by then). They keep their place, and the queue takes a work's
 * chapters in order, so they come next.
 */
export function retryBatch(ids?: string[]): RemoteQueue {
  const again = (j: RemoteJob) => j.status === 'failed' && j.kind === 'link' && (ids ? ids.includes(j.id) : !!j.batch)
  let jobs = listRemoteJobs()
  const works = new Set(jobs.filter((j) => again(j) && j.batch).map((j) => j.batch!.work))
  jobs = jobs.map((j) => (again(j) ? { ...j, status: 'queued', message: undefined, updatedAt: Date.now() } : j))
  for (const work of works) jobs = inChapterOrder(jobs, work)
  save(jobs)
  return remoteQueue()
}

/**
 * The queue runs in the order of the list. When a range is added or a chapter tried again, the work's
 * queued chapters are put together in the order of their numbers, where the work first comes in the
 * queue (an earlier range added later goes first); the queue window moves them by hand after.
 */
function inChapterOrder(jobs: RemoteJob[], work: string): RemoteJob[] {
  const key = work.toLowerCase()
  const ofWork = (j: RemoteJob) => j.batch?.work.toLowerCase() === key
  const queued = jobs.filter((j) => j.status === 'queued')
  const first = queued.findIndex(ofWork)
  if (first < 0) return jobs
  const block = queued.filter(ofWork).sort((a, b) => a.batch!.chapter - b.batch!.chapter)
  const rest = queued.filter((j) => !ofWork(j))
  const before = queued.slice(0, first).filter((j) => !ofWork(j)).length
  return withQueued(jobs, [...rest.slice(0, before), ...block, ...rest.slice(before)])
}

/** The list with its queued requests, in the places they hold, replaced by `queued` in that order. */
function withQueued(jobs: RemoteJob[], queued: RemoteJob[]): RemoteJob[] {
  let k = 0
  return jobs.map((j) => (j.status === 'queued' ? queued[k++] : j))
}

/** The queued requests in this order (`ids`; the ones left out keep their order after them). */
export function reorderQueue(ids: string[]): RemoteQueue {
  const jobs = listRemoteJobs()
  const queued = jobs.filter((j) => j.status === 'queued')
  save(withQueued(jobs, [...ids.flatMap((id) => queued.filter((j) => j.id === id)), ...queued.filter((j) => !ids.includes(j.id))]))
  return remoteQueue()
}

/** Every work's queued chapters back in the order of their numbers. */
export function sortQueue(): RemoteQueue {
  let jobs = listRemoteJobs()
  for (const work of new Set(jobs.filter((j) => j.status === 'queued' && j.batch).map((j) => j.batch!.work))) jobs = inChapterOrder(jobs, work)
  save(jobs)
  return remoteQueue()
}

export function addLinkJob(url: string, device: string): RemoteJob {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Só links http ou https.')
  return add({ kind: 'link', url, name: parsed.hostname + parsed.pathname, device })
}

export function addPdfJob(name: string, pdf: Buffer, device: string): RemoteJob {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('O arquivo enviado não é um PDF.')
  const clean = (name.trim() || 'capitulo.pdf').replace(/[\\/:*?"<>|]+/g, ' ')
  // Written before the job is listed, so the window never takes a job whose PDF is not there yet.
  return add({ kind: 'pdf', name: /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`, device }, (id) => writeFileSync(pdfPath(id), pdf))
}

function add(fields: Pick<RemoteJob, 'kind' | 'name' | 'device'> & { url?: string }, before?: (id: string) => void): RemoteJob {
  mkdirSync(dir(), { recursive: true })
  const now = Date.now()
  const job: RemoteJob = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now, status: 'queued' }
  before?.(job.id)
  save([...listRemoteJobs(), job])
  return job
}

/**
 * The oldest queued job, now marked running, with its PDF when the phone sent one. Jobs left running
 * when the app closed go back to the queue first.
 */
export function takeRemoteJob(): { job: RemoteJob; pdf: Uint8Array | null } | null {
  const { jobs, paused } = remoteQueue()
  if (paused) return null
  const next = jobs.find((j) => j.status === 'queued')
  if (!next) return null
  const job: RemoteJob = { ...next, status: 'running', message: 'Começando', updatedAt: Date.now() }
  save(jobs.map((j) => (j.id === job.id ? job : j)))
  let pdf: Uint8Array | null = null
  if (job.kind === 'pdf') {
    try {
      pdf = new Uint8Array(readFileSync(pdfPath(job.id)))
    } catch {
      updateRemoteJob(job.id, { status: 'failed', message: 'O PDF enviado sumiu do PC.' })
      return null
    }
  }
  return { job, pdf }
}

export function updateRemoteJob(id: string, patch: Partial<Pick<RemoteJob, 'status' | 'message' | 'entryId'>>): void {
  const jobs = listRemoteJobs()
  save(jobs.map((j) => (j.id === id ? { ...j, ...patch, updatedAt: Date.now() } : j)))
  // The PDF is in the library now (or could not be used); the phone's copy is not needed.
  if (patch.status === 'done' || patch.status === 'failed') rmSync(pdfPath(id), { force: true })
}

/** Takes a job off the queue (the phone changed its mind); one already running finishes. */
export function cancelRemoteJob(id: string): void {
  const jobs = listRemoteJobs()
  if (!jobs.some((j) => j.id === id && j.status === 'queued')) return
  save(jobs.filter((j) => j.id !== id))
  rmSync(pdfPath(id), { force: true })
}

/** Jobs left running when the app closed start over. */
export function requeueInterrupted(): void {
  const jobs = listRemoteJobs()
  if (!jobs.some((j) => j.status === 'running')) return
  save(jobs.map((j) => (j.status === 'running' ? { ...j, status: 'queued', message: undefined } : j)))
}
