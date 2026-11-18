import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteJob, RemoteQueue } from '../shared/remoteJobs'
import type { TranslateOptions } from '../shared/types'
import { parseChapterName } from '../shared/works'

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
    return { jobs: jobs.map(withWork), paused: stored.paused === true }
  } catch {
    return { jobs: [], paused: false }
  }
}

/**
 * A PDF named for its work and number ("Name - Volume 08", "Name Chapter 12") belongs with that work's
 * other chapters in the queue, like a range asked for on the PC (also the ones queued before this).
 */
function withWork(job: RemoteJob): RemoteJob {
  if (job.kind !== 'pdf' || job.batch) return job
  const parsed = parseChapterName(job.name)
  return parsed.work && parsed.chapter != null ? { ...job, batch: { work: parsed.work, chapter: parsed.chapter, site: 'pdf' } } : job
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
export function addBatch(
  work: string,
  site: string,
  chapters: { chapter: number; url: string }[],
  download = false,
  device = 'PC',
  options: Partial<TranslateOptions> | null = null
): RemoteQueue {
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
    batch: { work: clean, chapter: c.chapter, site, ...(download && { download }) },
    ...(options && !download && { options })
  }))
  save(inChapterOrder([...listRemoteJobs(), ...added], clean))
  return remoteQueue()
}

/**
 * The options sent with a request, kept when they are ones the app knows (a phone on another version may
 * send others); null for none.
 */
export function cleanOptions(raw: unknown): Partial<TranslateOptions> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: Partial<TranslateOptions> = {}
  const text = (k: 'activeProfileId' | 'sourceLanguage' | 'targetLanguage') => typeof r[k] === 'string' && (out[k] = r[k] as string)
  text('activeProfileId')
  text('sourceLanguage')
  text('targetLanguage')
  if (typeof r.concurrency === 'number') out.concurrency = Math.min(8, Math.max(1, Math.round(r.concurrency)))
  if (r.speed === 'fast' || r.speed === 'balanced' || r.speed === 'quality') out.speed = r.speed
  if (typeof r.translateSfx === 'boolean') out.translateSfx = r.translateSfx
  if (typeof r.reuseLayers === 'boolean') out.reuseLayers = r.reuseLayers
  if (r.contentType === 'auto' || r.contentType === 'comic' || r.contentType === 'novel') out.contentType = r.contentType
  if (typeof r.skipStart === 'number') out.skipStart = Math.min(50, Math.max(0, Math.round(r.skipStart)))
  if (typeof r.skipEnd === 'number') out.skipEnd = Math.min(50, Math.max(0, Math.round(r.skipEnd)))
  if (r.gpuSharing === 'auto' || r.gpuSharing === 'phased' || r.gpuSharing === 'together') out.gpuSharing = r.gpuSharing
  if (r.aiDevice === 'gpu' || r.aiDevice === 'cpu') out.aiDevice = r.aiDevice
  if (r.visionDevice === 'gpu' || r.visionDevice === 'cpu') out.visionDevice = r.visionDevice
  return Object.keys(out).length ? out : null
}

/** Every queued request (or the ones in `ids`) is translated with these options; null goes back to the PC's settings. */
export function setQueueOptions(options: Partial<TranslateOptions> | null, ids?: string[]): RemoteQueue {
  save(
    listRemoteJobs().map((j) => {
      if (j.status !== 'queued' || (ids && !ids.includes(j.id))) return j
      const { options: _old, ...rest } = j
      return options ? { ...rest, options } : rest
    })
  )
  return remoteQueue()
}

/** Takes every queued chapter of the ranges asked for on the PC off the queue. */
export function clearBatch(): RemoteQueue {
  const jobs = listRemoteJobs()
  const gone = jobs.filter((j) => j.batch && j.status === 'queued')
  save(jobs.filter((j) => !gone.includes(j)))
  // PDFs chosen on the PC (grouped by work too) leave their file behind otherwise.
  for (const job of gone) if (job.kind === 'pdf') rmSync(pdfPath(job.id), { force: true })
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
  jobs = jobs.map((j) => (again(j) ? { ...j, status: 'queued', message: undefined, progress: undefined, updatedAt: Date.now() } : j))
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

export function addLinkJob(url: string, device: string, options: Partial<TranslateOptions> | null = null): RemoteJob {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Só links http ou https.')
  return add({ kind: 'link', url, name: parsed.hostname + parsed.pathname, device, ...(options && { options }) })
}

export function addPdfJob(name: string, pdf: Buffer, device: string, options: Partial<TranslateOptions> | null = null): RemoteJob {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('O arquivo enviado não é um PDF.')
  const clean = (name.trim() || 'capitulo.pdf').replace(/[\\/:*?"<>|]+/g, ' ')
  const job = withWork({ kind: 'pdf', name: /\.pdf$/i.test(clean) ? clean : `${clean}.pdf` } as RemoteJob)
  // Written before the job is listed, so the window never takes a job whose PDF is not there yet.
  return add({ kind: 'pdf', name: job.name, device, ...(options && { options }), ...(job.batch && { batch: job.batch }) }, (id) =>
    writeFileSync(pdfPath(id), pdf)
  )
}

function add(fields: Pick<RemoteJob, 'kind' | 'name' | 'device' | 'options' | 'batch'> & { url?: string }, before?: (id: string) => void): RemoteJob {
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

export function updateRemoteJob(id: string, patch: Partial<Pick<RemoteJob, 'status' | 'message' | 'entryId' | 'progress'>>): void {
  const jobs = listRemoteJobs()
  // How far it got only means something while it runs.
  const progress = patch.status && patch.status !== 'running' ? { progress: undefined } : {}
  save(jobs.map((j) => (j.id === id ? { ...j, ...patch, ...progress, updatedAt: Date.now() } : j)))
  // The PDF is in the library now (or could not be used); the phone's copy is not needed.
  if (patch.status === 'done' || patch.status === 'failed') rmSync(pdfPath(id), { force: true })
}

/** Takes a job off the queue (the phone changed its mind); one running is stopped by the window, which sees it gone. */
export function cancelRemoteJob(id: string): void {
  const jobs = listRemoteJobs()
  if (!jobs.some((j) => j.id === id && (j.status === 'queued' || j.status === 'running'))) return
  save(jobs.filter((j) => j.id !== id))
  rmSync(pdfPath(id), { force: true })
}

/** Jobs left running when the app closed start over. */
export function requeueInterrupted(): void {
  const jobs = listRemoteJobs()
  if (!jobs.some((j) => j.status === 'running')) return
  save(jobs.map((j) => (j.status === 'running' ? { ...j, status: 'queued', message: undefined, progress: undefined } : j)))
}
