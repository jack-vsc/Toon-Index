import { app, BrowserWindow, Notification, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chaptersUpTo, latestChapter, MAX_SOURCES, type PageLink, type SourceCheck, type UpdatesStatus, type WorkUpdate } from '../shared/updates'
import { displayName, type Work } from '../shared/works'
import { listLibrary, listWorks, saveWorkSources } from './library'
import { addBatch, listRemoteJobs } from './remoteJobs'
import { listReading } from './reading'
import { autoLink, mangadexLatest } from './catalog'
import { hiddenWindow, isChallenged, open, sleep } from './webChapter'

/** The sites are checked this often while the app is open; more would only burden them. */
const EVERY_MS = 2 * 60 * 60_000
/** A pause between sites, so a run looks like a person going through a few pages. */
const BETWEEN_SITES_MS = 5_000
/** Chapter lists drawn by scripts get this long after the page loads. */
const SETTLE_MS = 3_000

interface Stored {
  checks: Record<string, SourceCheck>
  /** By work id: the chapter last announced, so each one is announced once. */
  announced: Record<string, number>
  lastRun: number | null
  /** ntfy.sh topic the phone subscribes to; null while phone notifications are off. */
  ntfyTopic: string | null
}

const path = (): string => join(app.getPath('userData'), 'updates.json')
const listeners = new Set<() => void>()
let running = false
let timer: NodeJS.Timeout | null = null

export function onUpdatesChanged(listener: () => void): void {
  listeners.add(listener)
}

function load(): Stored {
  try {
    return { checks: {}, announced: {}, lastRun: null, ntfyTopic: null, ...(JSON.parse(readFileSync(path(), 'utf8')) as Partial<Stored>) }
  } catch {
    return { checks: {}, announced: {}, lastRun: null, ntfyTopic: null }
  }
}

function save(stored: Stored): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(path(), JSON.stringify(stored, null, 2))
  for (const listener of listeners) listener()
}

export function updatesStatus(): UpdatesStatus {
  const stored = load()
  return { updates: workUpdates(listWorks(), stored.checks), checks: stored.checks, lastRun: stored.lastRun, running, ntfyTopic: stored.ntfyTopic }
}

/** Each work's newest chapter on any of its sites. */
function workUpdates(works: Work[], checks: Record<string, SourceCheck>): Record<string, WorkUpdate> {
  const updates: Record<string, WorkUpdate> = {}
  for (const work of works) {
    for (const source of work.sources ?? []) {
      const check = checks[source]
      if (!check || check.latest === null || !check.latestUrl) continue
      const current = updates[work.id]
      if (current && current.latest >= check.latest) continue
      updates[work.id] = {
        workId: work.id,
        latest: check.latest,
        url: check.latestUrl,
        site: new URL(source).hostname.replace(/^www\./, ''),
        checkedAt: check.checkedAt
      }
    }
  }
  return updates
}

export function setWorkSources(workId: string, sources: string[]): void {
  const clean = [...new Set(sources.map((s) => s.trim()).filter(Boolean))].slice(0, MAX_SOURCES)
  for (const s of clean) {
    if (!/^https?:\/\//i.test(s)) throw new Error(`"${s}" não é um link http ou https.`)
  }
  saveWorkSources(workId, clean)
  for (const listener of listeners) listener()
}

/** Turns phone notifications on (a new, hard to guess topic) or off. */
export function setNtfy(enabled: boolean): UpdatesStatus {
  const stored = load()
  save({ ...stored, ntfyTopic: enabled ? stored.ntfyTopic ?? `manga-index-${randomBytes(12).toString('hex')}` : null })
  return updatesStatus()
}

/** Checks now and then while the app is open, starting a little after it opens. */
export function startUpdates(): void {
  const tick = (): void => {
    const { lastRun } = load()
    if (!lastRun || Date.now() - lastRun >= EVERY_MS) void checkNow()
  }
  setTimeout(tick, 60_000)
  timer = setInterval(tick, 10 * 60_000)
}

export function stopUpdates(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Opens every work's sites in turn and announces chapters beyond the last one read. */
export async function checkNow(): Promise<void> {
  if (running) return
  running = true
  for (const listener of listeners) listener()
  const win = hiddenWindow()
  try {
    // Works not looked up yet on the catalog sites get their names, cover and pages there first.
    await autoLink(win).catch((err: Error) => console.warn('[catalog] auto link failed:', err.message))
    const sources = [...new Set(listWorks().flatMap((w) => w.sources ?? []))]
    for (const [i, source] of sources.entries()) {
      if (i > 0) await sleep(BETWEEN_SITES_MS)
      const check = await checkSource(win, source)
      const stored = load()
      save({ ...stored, checks: { ...stored.checks, [source]: check } })
    }
    const stored = load()
    save({ ...stored, lastRun: Date.now(), announced: await announce(stored) })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    running = false
    for (const listener of listeners) listener()
  }
}

async function checkSource(win: BrowserWindow, source: string): Promise<SourceCheck> {
  const failed = (error: string): SourceCheck => ({ checkedAt: Date.now(), latest: null, latestUrl: null, error })
  try {
    // MangaDex draws its chapter list from its API, which answers directly.
    if (/^https:\/\/mangadex\.org\//i.test(source)) {
      const found = await mangadexLatest(source)
      if (!found) return failed('Nenhum capítulo em inglês ou português no MangaDex.')
      return { checkedAt: Date.now(), latest: found.chapter, latestUrl: found.url }
    }
    await open(win, source)
    // The check runs unattended: a site asking for a bot check is left for when the person opens it.
    for (let waited = 0; await isChallenged(win); waited += 1_000) {
      if (waited > 20_000) return failed('O site pediu uma verificação: abra o link no app (Abrir link) uma vez para passar.')
      await sleep(1_000)
    }
    await sleep(SETTLE_MS)
    const links = (await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.innerText || a.textContent || '').trim().slice(0, 120) }))`
    )) as PageLink[]
    // A site that moved to another address sends the old links there.
    // The work's name is taken from the link given: a site's list of every work it lands on instead has none.
    const landed = win.webContents.getURL()
    const page = new URL(source)
    page.hostname = new URL(landed).hostname
    const found = latestChapter(page.href, links)
    if (!found && new URL(landed).hostname !== new URL(source).hostname) {
      return failed(`O link levou para ${new URL(landed).hostname}: o site pode ter mudado de endereço ou saído do ar. Troque o link.`)
    }
    if (!found && new URL(landed).pathname !== new URL(source).pathname) {
      return failed('O link levou para outra página: a obra pode ter mudado de endereço no site. Troque o link.')
    }
    if (!found) return failed('Nenhum capítulo encontrado nesta página. Use a página da obra, a que lista os capítulos.')
    return { checkedAt: Date.now(), latest: found.chapter, latestUrl: found.url }
  } catch (err) {
    return failed((err as Error).message)
  }
}

/**
 * Chapters newer than the last one read and than the last one announced, once each: on the PC and,
 * when turned on, on the phone through ntfy. A work's first check only notes where it is.
 */
async function announce(stored: Stored): Promise<Record<string, number>> {
  const works = listWorks()
  const reading = listReading()
  const announced = { ...stored.announced }
  for (const update of Object.values(workUpdates(works, stored.checks))) {
    const before = announced[update.workId]
    announced[update.workId] = Math.max(before ?? 0, update.latest)
    if (before === undefined || update.latest <= before) continue
    const read = reading.filter((r) => r.workId === update.workId && r.status === 'read').map((r) => r.chapter)
    if (read.length && update.latest <= Math.max(...read)) continue
    const work = works.find((w) => w.id === update.workId)
    const name = work ? displayName(work.names[0]) : 'Obra'
    const queued = work?.auto ? queueNew(work, update, Math.max(before, ...read)) : 0
    const body = `Capítulo ${update.latest} em ${update.site}${queued ? (work!.auto === 'translate' ? ' · traduzindo no PC' : ' · baixando no PC') : ''}`
    if (Notification.isSupported()) {
      const notification = new Notification({ title: `Capítulo novo: ${name}`, body })
      notification.on('click', () => void shell.openExternal(update.url))
      notification.show()
    }
    if (stored.ntfyTopic) await sendNtfy(stored.ntfyTopic, `Capítulo novo: ${name}`, body, update.url)
  }
  return announced
}

/**
 * The new chapters of a work set to be translated (or downloaded) by itself join the queue, the ones
 * since `from` that are neither in the library nor asked for already. Returns how many joined.
 */
function queueNew(work: Work, update: WorkUpdate, from: number): number {
  const have = new Set(listLibrary().filter((e) => e.workId === work.id).map((e) => e.chapter))
  const asked = new Set(listRemoteJobs().map((j) => j.url))
  const chapters = chaptersUpTo(update.url, update.latest, from).filter((c) => !have.has(c.chapter) && !asked.has(c.url))
  if (!chapters.length) return 0
  addBatch(displayName(work.names[0]), update.site, chapters, work.auto === 'download')
  return chapters.length
}

/** A push to the phone through ntfy.sh; the notification opens the chapter. */
async function sendNtfy(topic: string, title: string, message: string, click: string): Promise<void> {
  try {
    await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, click, tags: ['books'] })
    })
  } catch (err) {
    console.warn('[updates] ntfy failed:', (err as Error).message)
  }
}
