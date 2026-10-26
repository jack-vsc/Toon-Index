import { BrowserWindow, session, type WebContents } from 'electron'
import type { WebChapter, WebChapterProgress } from '../shared/types'

/**
 * Chapter pages from a reader page on the web. The page is opened in a hidden window, since most
 * readers build the page with scripts and only load images as they scroll into view; it is scrolled to
 * the bottom, then the reader's images (the large ones, in page order) are downloaded with the site's
 * cookies and the page as referer, as the site's own reader does.
 */

/** Separate cookie store, kept between runs so a site's checks are passed once. */
export const PARTITION = 'persist:web-chapters'
const LOAD_TIMEOUT_MS = 60_000
/** A page still showing a bot check after this long needs the person to pass it in a visible window. */
const CHALLENGE_WAIT_MS = 8_000
const CHALLENGE_TIMEOUT_MS = 120_000
const PARALLEL_DOWNLOADS = 4

let running: { cancelled: boolean; win: BrowserWindow | null } | null = null

export async function fetchWebChapter(url: string, sender: WebContents): Promise<WebChapter> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Informe um link que comece com http:// ou https://.')
  cancelWebChapter()
  const job: { cancelled: boolean; win: BrowserWindow | null } = { cancelled: false, win: null }
  running = job
  const progress = (p: WebChapterProgress): void => {
    if (!sender.isDestroyed()) sender.send('web:progress', p)
  }
  const ses = session.fromPartition(PARTITION)
  // Image servers check the referer; Electron's fetch may not set it, so it is added on the way out.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'referer')) headers.Referer = url
    callback({ requestHeaders: headers })
  })
  plainUserAgent(ses)
  const mangadex = /^https:\/\/mangadex\.org\/chapter\/([0-9a-f-]{36})/i.exec(url)?.[1]
  if (mangadex) {
    try {
      return await mangadexChapter(mangadex, ses, job, progress)
    } finally {
      ses.webRequest.onBeforeSendHeaders(null)
      if (running === job) running = null
    }
  }
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    title: 'Verificação do site',
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })
  job.win = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.setAudioMuted(true)
  try {
    progress({ stage: 'loading' })
    await open(win, url)
    await passChallenge(win, job, progress)
    check(job)
    progress({ stage: 'scrolling' })
    await scrollToBottom(win, job)
    const found = (await win.webContents.executeJavaScript(COLLECT)) as { title: string; urls: string[] }
    if (!found.urls.length) {
      throw new Error('Não encontrei as páginas do capítulo nesse link. Confira se é a página de leitura do capítulo.')
    }
    const images: Uint8Array[] = new Array(found.urls.length)
    let done = 0
    progress({ stage: 'downloading', done, total: found.urls.length })
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < found.urls.length) {
        check(job)
        const i = next++
        images[i] = await download(win, ses, found.urls[i])
        progress({ stage: 'downloading', done: ++done, total: found.urls.length })
      }
    }
    await Promise.all(Array.from({ length: PARALLEL_DOWNLOADS }, worker))
    return { title: cleanTitle(found.title) || new URL(url).hostname, images }
  } finally {
    ses.webRequest.onBeforeSendHeaders(null)
    if (!win.isDestroyed()) win.destroy()
    if (running === job) running = null
  }
}

/** MangaDex's reader draws its pages from its image API, which gives their addresses directly. */
async function mangadexChapter(
  id: string,
  ses: Electron.Session,
  job: { cancelled: boolean },
  progress: (p: WebChapterProgress) => void
): Promise<WebChapter> {
  progress({ stage: 'loading' })
  const json = async (url: string): Promise<unknown> => {
    const res = await ses.fetch(url)
    if (!res.ok) throw new Error(`O MangaDex respondeu ${res.status}.`)
    return res.json()
  }
  const server = (await json(`https://api.mangadex.org/at-home/server/${id}`)) as { baseUrl: string; chapter: { hash: string; data: string[] } }
  const info = (await json(`https://api.mangadex.org/chapter/${id}?includes[]=manga`)) as {
    data: { attributes: { chapter: string | null; title: string | null }; relationships: { type: string; attributes?: { title: Record<string, string> } }[] }
  }
  const titles = info.data.relationships.find((r) => r.type === 'manga')?.attributes?.title ?? {}
  const work = titles.en ?? Object.values(titles)[0] ?? 'MangaDex'
  const urls = server.chapter.data.map((file) => `${server.baseUrl}/data/${server.chapter.hash}/${file}`)
  if (!urls.length) throw new Error('Esse capítulo do MangaDex não tem páginas (pode estar só num site oficial).')
  const images: Uint8Array[] = []
  for (const [i, page] of urls.entries()) {
    check(job)
    progress({ stage: 'downloading', done: i, total: urls.length })
    const res = await ses.fetch(page)
    if (!res.ok) throw new Error(`Não foi possível baixar a página ${i + 1} do MangaDex (HTTP ${res.status}).`)
    images.push(new Uint8Array(await res.arrayBuffer()))
  }
  progress({ stage: 'downloading', done: urls.length, total: urls.length })
  return { title: `${work} Chapter ${info.data.attributes.chapter ?? ''}`.trim(), images }
}

export function cancelWebChapter(): void {
  if (!running) return
  running.cancelled = true
  if (running.win && !running.win.isDestroyed()) running.win.destroy()
  running = null
}

/** Sites turn away browsers that announce themselves as Electron. */
export function plainUserAgent(ses: Electron.Session): void {
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|manga-index)\/\S+/gi, ''))
}

/**
 * A window of the site for the person to sign in themselves (the app never sees the password). The
 * session stays in the app's browser partition, so later downloads from the site go in signed in.
 */
export function openSiteLogin(url: string, parent?: BrowserWindow): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Informe um link que comece com http:// ou https://.')
  plainUserAgent(session.fromPartition(PARTITION))
  const webPreferences = { partition: PARTITION, sandbox: true, contextIsolation: true }
  const win = new BrowserWindow({ width: 1000, height: 820, title: 'Entre na sua conta e feche esta janela', autoHideMenuBar: true, parent, webPreferences })
  // Signing in with Google or Discord opens their page in a pop-up.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences } }))
  void win.loadURL(url)
  return new Promise((resolve) => win.on('closed', () => resolve()))
}

/** A window never shown, for reading sites' pages unattended (new chapters, looking works up). */
export function hiddenWindow(): BrowserWindow {
  plainUserAgent(session.fromPartition(PARTITION))
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.setAudioMuted(true)
  return win
}

function check(job: { cancelled: boolean }): void {
  if (job.cancelled) throw new Error('Cancelado.')
}

/**
 * Loads the page; pages full of ads may never finish loading, so the document being ready is enough
 * (after a few seconds more for the reader's scripts). Fails only when the page itself cannot load.
 */
export function open(win: BrowserWindow, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('O site demorou demais para abrir.')), LOAD_TIMEOUT_MS)
    // Off once settled: a window that loads page after page (long chapter lists) would pile them up.
    const failed = (_e: Electron.Event, code: number, description: string, _url: string, isMainFrame: boolean): void => {
      // -3 is a navigation replaced by another (redirects).
      if (isMainFrame && code !== -3) done(new Error(`Não foi possível abrir o link (${description}).`))
    }
    const done = (err?: Error): void => {
      clearTimeout(timer)
      win.webContents.off('did-fail-load', failed)
      if (err) reject(err)
      else resolve()
    }
    win.webContents.on('did-fail-load', failed)
    win.webContents.once('dom-ready', () => {
      const finished = new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
      Promise.race([finished, sleep(5_000)]).then(() => done())
    })
    win.loadURL(url).catch(() => undefined)
  })
}

/** Cloudflare-like checks pass on their own most of the time; otherwise the window is shown for the person. */
async function passChallenge(
  win: BrowserWindow,
  job: { cancelled: boolean },
  progress: (p: WebChapterProgress) => void
): Promise<void> {
  const challenged = (): Promise<boolean> => isChallenged(win)
  const started = Date.now()
  let shown = false
  while (await challenged()) {
    check(job)
    if (!shown && Date.now() - started > CHALLENGE_WAIT_MS) {
      shown = true
      progress({ stage: 'challenge' })
      win.show()
    }
    if (Date.now() - started > CHALLENGE_TIMEOUT_MS) throw new Error('O site pediu uma verificação que não foi concluída.')
    await sleep(1_000)
  }
  if (shown) win.hide()
  // The real page loads after the check.
  if (shown || Date.now() - started > 1_500) await sleep(2_000)
}

/** Whether the page is a bot check (Cloudflare's "Just a moment…") rather than the site. */
export async function isChallenged(win: BrowserWindow): Promise<boolean> {
  return (
    !win.isDestroyed() &&
    ((await win.webContents.executeJavaScript(
      `/just a moment|um momento|attention required|verify you are human|checking your browser/i.test(document.title + ' ' + (document.body?.innerText ?? '').slice(0, 400))`
    )) as boolean)
  )
}

/** Scrolls down a screen at a time until the page stops growing, so lazy images get their address. */
async function scrollToBottom(win: BrowserWindow, job: { cancelled: boolean }): Promise<void> {
  let lastHeight = 0
  let still = 0
  for (let step = 0; step < 600 && still < 6; step++) {
    check(job)
    const { height, bottom } = (await win.webContents.executeJavaScript(
      `(() => { window.scrollBy(0, Math.round(window.innerHeight * 0.9)); const h = document.documentElement.scrollHeight; return { height: h, bottom: window.scrollY + window.innerHeight >= h - 4 } })()`
    )) as { height: number; bottom: boolean }
    still = bottom && height === lastHeight ? still + 1 : 0
    lastHeight = height
    await sleep(bottom ? 400 : 120)
  }
}

/**
 * The reader's images in page order: lazy-loading attributes included, small pictures (logos, covers
 * of other titles, ads) left out by comparing with the widest images on the page.
 */
const COLLECT = `(() => {
  const pick = (img) => {
    const lazy = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-cfsrc'].map((a) => img.getAttribute(a)).find((v) => v && !v.startsWith('data:image/gif'))
    const set = (img.getAttribute('data-srcset') || '').split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean).pop()
    const src = lazy || set || img.currentSrc || img.src
    try { return src ? new URL(src.trim(), location.href).href : '' } catch { return '' }
  }
  const imgs = [...document.querySelectorAll('img')].map((img) => {
    const r = img.getBoundingClientRect()
    return { url: pick(img), w: Math.max(img.naturalWidth, r.width), h: Math.max(img.naturalHeight, r.height), shown: r.width }
  }).filter((i) => /^(https?|data|blob):/.test(i.url) && !/\\.(svg|gif)(\\?|$)/i.test(i.url))
  const widest = Math.max(0, ...imgs.map((i) => i.shown))
  const seen = new Set()
  const urls = imgs.filter((i) => i.shown >= widest * 0.6 && i.w >= 300 && i.h >= 200).map((i) => i.url).filter((u) => !seen.has(u) && seen.add(u))
  return { title: document.title, urls }
})()`

async function download(win: BrowserWindow, ses: Electron.Session, url: string): Promise<Uint8Array> {
  // Addresses that only exist inside the page are read by the page itself.
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const base64 = (await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(url)}).then((r) => r.blob()).then((b) => new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(String(f.result).split(',')[1]); f.readAsDataURL(b) }))`
    )) as string
    return new Uint8Array(Buffer.from(base64, 'base64'))
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await ses.fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    } catch (err) {
      if (attempt >= 3) throw new Error(`Não foi possível baixar uma página (${url}): ${(err as Error).message}`)
      await sleep(800 * attempt)
    }
  }
}

/** "Name Chapter 53 - Site Name" → "Name Chapter 53". */
function cleanTitle(title: string): string {
  return title
    .replace(/\s+[|\-–—]\s+[^|–—]*$/, (tail) => (/cap|chap|ep/i.test(tail) ? tail : ''))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
