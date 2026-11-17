// Runs on every page; does nothing unless the page names a chapter ("Chapter 53", "/capitulo-53/")
// and shows its pages as images. Then it follows how far down the pages the reader gets and for how
// long, and tells the app (through background.js) where the reader is and whether the chapter was read.

const CHAPTER = /(?:\b(?:chapter|chap|ch|cap(?:[ií]tulo)?|ep(?:is[oó]dio|isode)?)\.?\s*[-#:]?\s*|#)(\d+(?:[.,]\d+)?)/i
/** Reached this far down the last page counts as having reached the end. */
const END = 0.92
/** Seconds of reading per page before a chapter counts as read (skimming it is not reading it). */
const SECONDS_PER_PAGE = 2
const MIN_SECONDS = 20
const MAX_SECONDS = 90
/** Web novels: their chapters are text, read by scrolling the whole page. Same list as the app's. */
const NOVEL = /novel|wuxia|ranobe|royalroad|scribblehub|comrademao|webnovel|mtlnation|novelupdates/i
/** How many "pages" a novel chapter counts as, for the reading time it needs. */
const NOVEL_PAGES = 15
/** A page opened only this long is not reported at all. */
const FIRST_REPORT_SECONDS = 5

let state = null
/** The work's page on the site, when the chapter's page links back to it: where its new chapters are listed. */
let workUrl = null

/**
 * The work and chapter the page is on. Most tabs say it ("Name Chapter 53 - Site"); sites that show
 * only their own name there ("MediocreToons", the link holding the chapter's id) say it on the page:
 * a heading or the chapter picker names the chapter, a heading or the link back to the work names it.
 */
function pageTitle() {
  if (CHAPTER.test(document.title)) return document.title
  // Only a chapter's own page ("/capitulo/591535") is read for it: a site's start page lists the
  // latest chapter of each work ("Cap. 180") without any being read.
  if (!CHAPTER.test(urlPath().replace(/[-_/]/g, ' '))) return document.title
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const shown = (el) => el.getClientRects().length > 0
  const short = (s) => s && s.length <= 120
  const named = (selector) => [...document.querySelectorAll(selector)].filter((el) => el.tagName === 'OPTION' || shown(el)).map(text).find((s) => short(s) && CHAPTER.test(s))
  // A heading saying it, with the work's name or alone ("Name - Capítulo 53", "Capítulo 53").
  const heading = named('h1, h2, h3')
  if (heading && heading.replace(CHAPTER, '').replace(/[^\p{L}]+/gu, '').length >= 3) return heading
  // Else a link to this very page naming the chapter, the chapter picker, or a label that is only the
  // chapter ("Cap. 99"): sites styled by utility classes alone have nothing else to go by.
  const self = location.href.split('#')[0]
  const label = new RegExp(`^${CHAPTER.source}$`, 'i')
  const found =
    heading ||
    [...document.querySelectorAll('a[href]')].filter((a) => shown(a) && a.href.split('#')[0] === self).map(text).find((s) => short(s) && CHAPTER.test(s)) ||
    named('select option:checked, h4, [class*="chapter" i], [class*="capitulo" i], [class*="title" i]') ||
    [...document.querySelectorAll('span, p, div, a, button, strong, b')].filter((el) => !el.children.length && shown(el)).map(text).find((s) => label.test(s))
  if (!found) return document.title
  const chapter = CHAPTER.exec(found)[0]
  // The work: the link back to its page (the one this chapter's address goes under, first), not the menu's.
  const here = location.pathname.toLowerCase()
  const menu = /^(home|in[ií]cio|series|s[eé]ries|obras?|mang[aá]s?|manhwas?|manhuas?|comics?|webtoons?|novels?|lista|list|todos?|all|browse|explorar|ranking|populares?|latest|recentes?)$/i
  const works = [...document.querySelectorAll('a[href]')]
    .filter((a) => !CHAPTER.test(text(a)) && short(text(a)) && text(a).length >= 3 && !menu.test(text(a)))
    .map((a) => ({ name: text(a), shown: shown(a), path: new URL(a.href, location.href).pathname.toLowerCase().replace(/\/$/, '') }))
    .filter((a) => /\/(obras?|manga|manhwa|manhua|series|serie|title|comics?|webtoon|novel)s?\/[^/]+/i.test(a.path))
  // One folded away on narrow screens (the header's) still counts, after the ones shown.
  const link = works.find((a) => here.startsWith(a.path + '/')) ?? works.find((a) => a.shown) ?? works[0]
  if (link) workUrl = location.origin + link.path
  return link ? `${link.name} - ${chapter}` : document.title
}

function urlPath() {
  try {
    return decodeURIComponent(location.pathname)
  } catch {
    return location.pathname
  }
}

function namesChapter() {
  return CHAPTER.test(pageTitle()) || CHAPTER.test(urlPath().replace(/[-_/]/g, ' '))
}

/** The chapter's page images: big, and wide compared with the window. */
function pageImages() {
  const minWidth = Math.min(300, window.innerWidth * 0.4)
  return [...document.images].filter((img) => {
    const box = img.getBoundingClientRect()
    return box.width >= minWidth && box.height >= 200 && img.naturalHeight >= 200
  })
}

function start() {
  state = { href: location.href, seconds: 0, progress: 0, pages: 0, sent: null, lastSent: 0 }
}

function isNovel() {
  return NOVEL.test(location.hostname) || NOVEL.test(location.pathname)
}

function measure() {
  if (isNovel()) {
    state.pages = NOVEL_PAGES
    const seen = (window.scrollY + window.innerHeight) / Math.max(1, document.documentElement.scrollHeight)
    state.progress = Math.max(state.progress ?? 0, Math.min(1, seen))
    return
  }
  const images = pageImages()
  if (!images.length) return
  state.pages = Math.max(state.pages, images.length)
  // One or two pages at a time: a reader that turns pages without scrolling; how far it got is unknown.
  if (images.length <= 2) {
    state.progress = null
    return
  }
  const top = images[0].getBoundingClientRect().top + window.scrollY
  const last = images[images.length - 1].getBoundingClientRect()
  const bottom = last.bottom + window.scrollY
  const seen = window.scrollY + window.innerHeight - top
  const progress = Math.min(1, Math.max(0, seen / Math.max(1, bottom - top)))
  if (state.progress !== null) state.progress = Math.max(state.progress, progress)
}

function finished() {
  const needed = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, state.pages * SECONDS_PER_PAGE))
  return state.progress !== null && state.progress >= END && state.seconds >= needed
}

function report(force) {
  if (!state || state.seconds < FIRST_REPORT_SECONDS || !state.pages) return
  const done = finished()
  const progress = state.progress === null ? null : Math.round(state.progress * 100) / 100
  const prev = state.sent
  const changed = !prev || done !== prev.finished || (progress !== null && progress - (prev.progress ?? 0) >= 0.05)
  if (!changed && !(force && prev && progress !== prev.progress)) return
  if (!force && Date.now() - state.lastSent < 5000 && prev && done === prev.finished) return
  state.sent = { progress, finished: done }
  state.lastSent = Date.now()
  try {
    chrome.runtime.sendMessage({ type: 'reading', report: { url: location.href, title: pageTitle(), ...(workUrl && { workUrl }), progress, finished: done, at: Date.now() } })
  } catch {
    // The extension was reloaded or removed while the page was open.
  }
}

// The popup asks what the page is about, as the reports say it.
chrome.runtime.onMessage?.addListener((message, _sender, reply) => {
  if (message?.type !== 'page') return
  reply({ title: pageTitle(), workUrl })
})

setInterval(() => {
  // Sites that change chapter without loading a new page.
  if (state && state.href !== location.href) {
    report(true)
    state = null
  }
  if (!state) {
    if (!namesChapter()) return
    start()
  }
  if (document.visibilityState === 'visible') state.seconds++
  measure()
  report(false)
}, 1000)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') report(true)
})
window.addEventListener('pagehide', () => report(true))

// ---------------------------------------------------------------------------------------------------
// A work's own page on a site (its chapters listed, none of them open): a button to put it on a
// reading list ("Quero ler"), drawn by the extension here, by the app on the phone.

const SHELVES = { plan: 'Quero ler', reading: 'Lendo', paused: 'Pausado', done: 'Concluído', dropped: 'Abandonado' }

/** The work the page is about, when it is a work's page: its name (from the page) and the page's address. */
function workPage() {
  // Not a chapter's address (its title may still name the newest chapter: "Name [Ch. 229]").
  if (CHAPTER.test(urlPath().replace(/[-_/]/g, ' '))) return null
  // A work's own address ("/obra/15403", "/manga/name/", "/title/…"): a site's start page or a genre's
  // list shows chapters too, of many works.
  const segments = urlPath().split('/').filter(Boolean)
  if (segments.length < 2 || !segments.slice(0, -1).some((s) => /^(obras?|mang[aá]s?|manhwas?|manhuas?|series|s[eé]ries?|titles?|comics?|webtoons?|novels?|read|ler)$/i.test(s))) return null
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const shown = (el) => el.getClientRects().length > 0
  // Its list of chapters: links that name one, in their text or their address.
  let chapters = 0
  for (const a of document.querySelectorAll('a[href]')) {
    let path = ''
    try {
      path = decodeURIComponent(new URL(a.href, location.href).pathname)
    } catch {}
    if (CHAPTER.test(text(a)) || CHAPTER.test(path.replace(/[-_/]/g, ' '))) chapters++
    if (chapters >= 3) break
  }
  // MangaDex draws its list late; its "/title/…" pages are always a work's.
  if (chapters < 3 && !(/(^|\.)mangadex\.org$/.test(location.hostname) && segments[0] === 'title')) return null
  const site = location.hostname.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase()
  const isSite = (s) => {
    const key = s.replace(/[^a-z0-9]/gi, '').toLowerCase()
    return key === site || (!/\s/.test(s) && key.length >= 6 && site.length >= 6 && key.slice(0, 6) === site.slice(0, 6))
  }
  const og = (document.querySelector('meta[property="og:title"]')?.content || '').split(/\s+[|–—-]\s+/)[0].trim()
  const name = [...[...document.querySelectorAll('h1')].filter(shown).map(text), document.title.split(/\s+[|–—-]\s+/)[0].trim(), og].find(
    (s) => s && s.length <= 150 && !CHAPTER.test(s) && !isSite(s)
  )
  return name ? { name, url: location.href.split('#')[0] } : null
}

let work = null

/** Looks again every couple of seconds (sites that draw the page late, or go to another work without loading). */
function watchWorkPage() {
  const found = workPage()
  if (found?.url === work?.url && found?.name === work?.name) return
  work = found
  if (typeof chrome.runtime.getURL === 'function') drawWorkButton()
  else chrome.runtime.sendMessage({ type: 'work', work })
}

let workButton = null

/** The extension's button, in a shadow root so the site's styles leave it alone. */
function drawWorkButton() {
  workButton?.remove()
  workButton = null
  if (!work) return
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647'
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `<style>
    * { box-sizing: border-box; font: 600 13px system-ui, sans-serif; }
    .fab { display: flex; align-items: center; gap: 6px; padding: 10px 16px; border: none; border-radius: 999px; background: #ff6740; color: #fff; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
    .fab.on { background: #1e1e22; color: #4ccf8a; border: 1px solid #4ccf8a; }
    .menu { position: absolute; right: 0; bottom: 52px; min-width: 200px; padding: 6px; border-radius: 14px; background: #1e1e22; border: 1px solid #33333a; box-shadow: 0 10px 30px rgba(0,0,0,.45); }
    .menu[hidden] { display: none; }
    .title { padding: 6px 10px 8px; color: #9e9ea8; font-weight: 500; font-size: 12px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item { display: block; width: 100%; padding: 8px 10px; border: none; border-radius: 8px; background: none; color: #ededf0; text-align: left; cursor: pointer; }
    .item:hover { background: #29292e; }
    .item.on { color: #ff8a5c; }
    .error { padding: 6px 10px; color: #ff6b6b; font-weight: 500; font-size: 12px; max-width: 240px; }
  </style>
  <div class="menu" hidden></div>
  <button class="fab"></button>`
  const fab = root.querySelector('.fab')
  const menu = root.querySelector('.menu')
  let info = null
  const ask = (type, patch) =>
    new Promise((resolve) => chrome.runtime.sendMessage({ type, page: { url: work.url, title: work.name, ...patch } }, (answer) => resolve(answer ?? { error: 'O Toon Index está fechado no PC.' })))
  const draw = (answer) => {
    if (answer && !answer.error) info = answer
    const shelf = info?.shelf && info.workId ? info.shelf : null
    fab.className = shelf ? 'fab on' : 'fab'
    fab.textContent = shelf ? `✓ ${SHELVES[shelf]}${info.favorite ? ' ♥' : ''}` : '＋ Quero ler'
    menu.innerHTML = ''
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = work.name
    menu.append(title)
    for (const [key, label] of Object.entries(SHELVES)) {
      const item = document.createElement('button')
      item.className = shelf === key ? 'item on' : 'item'
      item.textContent = (shelf === key ? '✓ ' : '') + label
      item.onclick = async () => draw(await ask('bookmark', { shelf: shelf === key ? null : key }))
      menu.append(item)
    }
    const fav = document.createElement('button')
    fav.className = info?.favorite ? 'item on' : 'item'
    fav.textContent = info?.favorite ? '♥ Favorita' : '♡ Favoritar'
    fav.onclick = async () => draw(await ask('bookmark', { favorite: !info?.favorite }))
    menu.append(fav)
    if (answer?.error) {
      const error = document.createElement('div')
      error.className = 'error'
      error.textContent = answer.error
      menu.append(error)
    }
  }
  fab.onclick = () => (menu.hidden = !menu.hidden)
  document.addEventListener('click', (e) => !e.composedPath().includes(host) && (menu.hidden = true))
  document.documentElement.append(host)
  workButton = host
  draw(null)
  ask('page').then(draw)
}

watchWorkPage()
setInterval(watchWorkPage, 2000)
