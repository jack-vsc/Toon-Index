/**
 * Chapters a paired phone asked the PC to translate: a site's link, or a PDF sent from the phone.
 * The PC app takes them one at a time when it is free, and the result goes into its library.
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
}
