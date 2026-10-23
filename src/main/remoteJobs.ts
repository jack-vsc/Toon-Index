import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteJob } from '../shared/remoteJobs'

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
  try {
    const jobs = (JSON.parse(readFileSync(listPath(), 'utf8')) as { jobs: RemoteJob[] }).jobs
    const old = Date.now() - KEEP_DONE_DAYS * 86_400_000
    return jobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.updatedAt > old)
  } catch {
    return []
  }
}

function save(jobs: RemoteJob[]): void {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(listPath(), JSON.stringify({ jobs }, null, 2))
  for (const listener of listeners) listener()
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
  const jobs = listRemoteJobs()
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
