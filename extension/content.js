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
/** A page opened only this long is not reported at all. */
const FIRST_REPORT_SECONDS = 5

let state = null

function namesChapter() {
  let path = location.pathname
  try {
    path = decodeURIComponent(path)
  } catch {}
  return CHAPTER.test(document.title) || CHAPTER.test(path.replace(/[-_/]/g, ' '))
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

function measure() {
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
    chrome.runtime.sendMessage({ type: 'reading', report: { url: location.href, title: document.title, progress, finished: done, at: Date.now() } })
  } catch {
    // The extension was reloaded or removed while the page was open.
  }
}

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
