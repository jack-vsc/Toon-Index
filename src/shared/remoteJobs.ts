/**
 * Chapters waiting to be translated on the PC: a site's link or a PDF sent from a paired phone, or a
 * range of a work's chapters asked for on the PC (to leave translating overnight, say). The PC app
 * takes them one at a time, in order, when it is free, and the result goes into its library.
 */

export type RemoteJobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface RemoteJob {
  id: string
  kind: 'link' | 'pdf'
  /** The chapter's page on the site (link), or the PDF's file name (pdf). */
  url?: string
  name: string
  /** The phone that asked. */
  device: string
  createdAt: number
  status: RemoteJobStatus
  /** What is happening now, or why it failed. */
  message?: string
  /** The library chapter made from it, once done. */
  entryId?: string
  updatedAt: number
  /** One chapter of a range asked for on the PC; `name` is then "Work Chapter 31", what it is saved as. */
  batch?: { work: string; chapter: number; site: string }
}

export interface RemoteQueue {
  jobs: RemoteJob[]
  /** Paused (to free the GPU for something else): nothing new starts, and the one running went back to the queue. */
  paused: boolean
}
