import { nativeImage, session, type BrowserWindow } from 'electron'
import { isLikelySameWork, isSameWork, readableNames, type CatalogMatch, type CatalogResult, type CatalogSite } from '../shared/catalog'
import { chapterLinks, fillChapterGaps, sourceFromChapter, type ChapterLink, type PageLink } from '../shared/updates'
import { formatOf, normalizeName, type Work } from '../shared/works'
import { applyCatalog, hasWorkCover, listWorks, saveWorkCover } from './library'
import { listReading } from './reading'
import { hiddenWindow, isChallenged, open, PARTITION, sleep } from './webChapter'

const MANGADEX = 'https://api.mangadex.org'
const MANGADEX_RATINGS = 'contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica'
/** Chapters in these languages count as out on MangaDex. */
const MANGADEX_LANGUAGES = 'translatedLanguage[]=en&translatedLanguage[]=pt-br'
/** Works looked up per run, so a big library is gone through over a few runs rather than all at once. */
const AUTO_PER_RUN = 5
/** Different names searched per work at most. */
const AUTO_SEARCHES = 3
/** A work none of the sites had is looked up again after this long (it may be added there later). */
const AUTO_RETRY_MS = 7 * 24 * 60 * 60_000
/** Wide enough for the library's big covers on a sharp screen. */
const COVER_WIDTH = 400
/** Works given a cover per run: MangaDex's API answers fast, so many more than are linked. */
const COVERS_PER_RUN = 20
/** Lists drawn by the page's scripts get this long after it loads. */
const SETTLE_MS = 3_000
const MANGADEX_PAGE = 500
const MANGADEX_MAX_CHAPTERS = 5_000
const CHOICES_PER_SITE = 5

const SEARCHES: Record<CatalogSite, (win: BrowserWindow, query: string) => Promise<CatalogMatch[]>> = {
  mangadex: (_win, query) => searchMangadex(query),
  mgeko: searchMgeko
}

/** Looks the name up on the catalog sites (all by default); a site that fails says why and leaves the others. */
export async function searchCatalog(query: string, win?: BrowserWindow, sites = Object.keys(SEARCHES) as CatalogSite[]): Promise<CatalogResult[]> {
  const name = query.trim()
  if (!name) return []
  return withWindow(win, async (w) => {
    const results: CatalogResult[] = []
    for (const site of sites) results.push(await attempt(site, () => SEARCHES[site](w, name)))
    return results
  })
}

/** The search for the person to choose from: the first results of each site, with their covers. */
export async function searchCatalogToChoose(query: string): Promise<CatalogResult[]> {
  const results = await searchCatalog(query)
  return Promise.all(
    results.map(async (r) => ({
      ...r,
      matches: await Promise.all(
        r.matches.slice(0, CHOICES_PER_SITE).map(async (m) => {
          const jpeg = m.cover ? await downloadCover(m.cover).catch(() => null) : null
          return jpeg
            ? {
                ...m,
                thumb: `data:image/jpeg;base64,${jpeg.toString('base64')}`
              }
            : m
        })
      )
    }))
  )
}

/**
 * Takes what the chosen matches know into the work: their names (in Latin letters), their pages to
 * check for new chapters, and the first cover found.
 */
export async function linkWork(workId: string, matches: CatalogMatch[], win?: BrowserWindow): Promise<Work[]> {
  return withWindow(win, async (w) => {
    const names: string[] = []
    for (const match of matches) {
      names.push(match.title, ...match.altNames)
    }
    let cover: Buffer | null = null
    for (const match of matches) {
      cover = match.cover ? await downloadCover(match.cover).catch(() => null) : null
      if (cover) break
    }
    return applyCatalog(workId, {
      names: readableNames(names),
      sources: matches.map((m) => m.url),
      sites: matches.map((m) => m.site),
      cover
    })
  })
}

/**
 * Works not looked up yet: each is searched by its name, and the matches that carry one of its names
 * exactly are linked. Anything less certain is left for the person ("Buscar nos sites").
 */
export async function autoLink(win: BrowserWindow): Promise<void> {
  const due = listWorks()
    .filter((w) => formatOf(w) === 'comic')
    .filter((w) => !w.catalog || (!w.catalog.sites.length && Date.now() - w.catalog.checkedAt > AUTO_RETRY_MS))
    .slice(0, AUTO_PER_RUN)
  for (const work of due) {
    const { picks, failed } = await findSameWork(work, win)
    // A site that failed (a bot check, say) is tried again next time.
    if (!picks.length && failed) continue
    await linkWork(work.id, picks, win)
    await sleep(3_000)
  }
}

/** When each work without a cover was last looked up for one (this run of the app). */
const coverTried = new Map<string, number>()

/**
 * Works still without a cover of their own (none of the sites had them by their exact name, or they were
 * never looked up) get one: MangaDex's, from the result named all but the same as one of the work's
 * names; else the one the work's own page on a site it is read on shows when shared (its og:image) —
 * scans name works their own way ("Logando 10.000 Anos no Futuro" is "Log into the Future").
 */
export async function autoCovers(win: BrowserWindow): Promise<number> {
  const reading = listReading()
  const due = listWorks()
    .filter((w) => !hasWorkCover(w.id) && Date.now() - (coverTried.get(w.id) ?? 0) > AUTO_RETRY_MS)
    .slice(0, COVERS_PER_RUN)
  let found = 0
  for (const work of due) {
    coverTried.set(work.id, Date.now())
    const read = reading.filter((r) => r.workId === work.id && r.url).sort((a, b) => b.updatedAt - a.updatedAt)
    const pages = [...new Set([...(work.sources ?? []), ...read.map((r) => sourceFromChapter(r.url)).filter((p): p is string => !!p)])]
    const jpeg = (formatOf(work) === 'comic' && (await mangadexCover(work))) || (await pageCover(win, pages.slice(0, 2)))
    if (jpeg) {
      saveWorkCover(work.id, jpeg)
      found++
    }
  }
  return found
}

async function mangadexCover(work: Work): Promise<Buffer | null> {
  for (const name of readableNames(work.names).slice(0, AUTO_SEARCHES)) {
    const match = (await searchMangadex(name).catch(() => [])).find((m) => m.cover && isLikelySameWork(work.names, m))
    const jpeg = match ? await downloadCover(match.cover!).catch(() => null) : null
    if (jpeg) return jpeg
  }
  return null
}

/** The picture the first of the pages that has one gives for being shared: the work's cover on scan sites. */
async function pageCover(win: BrowserWindow, pages: string[]): Promise<Buffer | null> {
  for (const page of pages) {
    try {
      await load(win, page)
      const image = (await win.webContents.executeJavaScript(
        `(() => { const m = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]'); return m ? new URL(m.content, location.href).href : null })()`
      )) as string | null
      if (!image) continue
      // WebP and AVIF, which scans use, only the page can read.
      const jpeg = (await downloadCover(image).catch(() => null)) ?? (await coverInPage(win, image).catch(() => null))
      // A site's own logo is no cover: covers are taller than wide.
      if (jpeg) {
        const { width, height } = nativeImage.createFromBuffer(jpeg).getSize()
        if (height > width) return jpeg
      }
    } catch {
      // The next page, or none this time.
    }
  }
  return null
}

/** The image opened on its own and drawn smaller as a JPEG by the page, for formats Electron cannot read. */
async function coverInPage(win: BrowserWindow, url: string): Promise<Buffer | null> {
  await load(win, url)
  const data = (await win.webContents.executeJavaScript(`(async () => {
    const bitmap = await createImageBitmap(await (await fetch(location.href)).blob())
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(${COVER_WIDTH}, bitmap.width)
    canvas.height = Math.round((bitmap.height * canvas.width) / bitmap.width)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  })()`)) as string
  return data.startsWith('data:image/jpeg;base64,') ? Buffer.from(data.split(',')[1], 'base64') : null
}

/**
 * The work on each site, by its names. The sites often list it under another English name, so the
 * names one site gives are searched on the sites that did not find it yet.
 */
async function findSameWork(work: Work, win: BrowserWindow): Promise<{ picks: CatalogMatch[]; failed: boolean }> {
  const picks = new Map<CatalogSite, CatalogMatch>()
  const names = readableNames(work.names)
  const searched = new Set<string>()
  let failed = false
  for (let round = 0; round < AUTO_SEARCHES; round++) {
    const missing = (Object.keys(SEARCHES) as CatalogSite[]).filter((s) => !picks.has(s))
    const query = names.find((n) => !searched.has(normalizeName(n)))
    if (!missing.length || !query) break
    searched.add(normalizeName(query))
    for (const result of await searchCatalog(query, win, missing)) {
      failed ||= !!result.error
      const match = result.matches.find((m) => isSameWork(names, m))
      if (!match) continue
      picks.set(result.site, match)
      names.push(...readableNames([match.title, ...match.altNames]))
    }
  }
  return { picks: [...picks.values()], failed }
}

/**
 * Every chapter of the work on its site, in order, for translating a range of them. MangaDex's are the
 * English ones it hosts (not links to official sites); mgeko lists them all on one page.
 */
export async function chapterList(match: { site: CatalogSite | 'link'; url: string }): Promise<ChapterLink[]> {
  // A pasted MangaDex link too: its site lists the chapters a page at a time, the API all of them.
  if (match.site === 'mangadex' || mangadexId(match.url)) return mangadexChapters(match.url)
  if (match.site === 'link') return pageChapters(match.url)
  return withWindow(undefined, async (w) => {
    await load(w, new URL('all-chapters/', match.url.endsWith('/') ? match.url : `${match.url}/`).href)
    // The page's list holds this work's chapters only, older ones under another name in their links.
    const links = (await w.webContents.executeJavaScript(
      `[...document.querySelectorAll('.chapter-list a[href]')].map((a) => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 120) }))`
    )) as PageLink[]
    return chapterLinks(match.url, links, true)
  })
}

/** Any site: the chapters linked from the work's page, scrolled to the end for lists that load as they show. */
async function pageChapters(url: string): Promise<ChapterLink[]> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Cole o link da página da obra (o que começa com https://).')
  return withWindow(undefined, async (w) => {
    await load(w, url)
    // After the wait: some sites only send to their sign-in page once the page's script has run.
    await sleep(SETTLE_MS)
    if (/\/(entrar|login|signin|sign-in|auth)\b/i.test(new URL(w.webContents.getURL()).pathname)) {
      throw new Error('O site pediu login: clique em "Entrar no site", entre com a sua conta e tente de novo.')
    }
    // Long lists come a page at a time (numbered pages, "next" links, or buttons that swap the list in
    // place): every page is read until one adds no chapter.
    const seen = new Map<string, PageLink>()
    let found = 0
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      for (const link of await pageLinks(w)) seen.set(link.href, link)
      const count = chapterLinks(url, [...seen.values()]).length
      if (page > 1 && count <= found) break
      found = count
      const before = await listSignature(w)
      const next = (await w.webContents.executeJavaScript(`(${NEXT_PAGE})(${page + 1})`)) as { href: string } | { clicked: true } | null
      if (!next) break
      if ('href' in next) {
        await load(w, next.href)
        await sleep(PAGE_SETTLE_MS)
      } else {
        for (let waited = 0; waited < 8_000 && (await listSignature(w)) === before; waited += 300) await sleep(300)
      }
    }
    return fillChapterGaps(chapterLinks(url, [...seen.values()]))
  })
}

// Sites with ten chapters a page list long works over a hundred pages.
const MAX_LIST_PAGES = 200
const PAGE_SETTLE_MS = 1_500

/** The page's links, scrolled to the end first for lists that load as they show. */
async function pageLinks(w: BrowserWindow): Promise<PageLink[]> {
  for (let i = 0; i < 30; i++) {
    const bottom = (await w.webContents.executeJavaScript(
      `(() => { window.scrollBy(0, window.innerHeight); return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4 })()`
    )) as boolean
    if (bottom) break
    await sleep(250)
  }
  return (await w.webContents.executeJavaScript(
    `[...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 120) }))`
  )) as PageLink[]
}

/** Changes when a list swapped in place has loaded its next page. */
function listSignature(w: BrowserWindow): Promise<string> {
  return w.webContents.executeJavaScript(`[...document.querySelectorAll('a[href]')].map((a) => a.href).join('|')`) as Promise<string>
}

/**
 * Runs in the page: goes to the list's page `want` — a rel="next" link, the pager's button numbered
 * `want`, a "next" link or button by label or arrow, else any button numbered `want`. Returns the link to load, { clicked } for a button that
 * swaps the list in place, or null on the last page. Links and buttons to chapters are no pages.
 */
const NEXT_PAGE = `(want) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const usable = (el) => {
    const r = el.getBoundingClientRect()
    const off = el.disabled || el.getAttribute('aria-disabled') === 'true' || /\\bdisabled\\b/.test(String(el.className))
    const chapter = /cap[ií]tulo|chapter|\\bch\\.?\\s*\\d|\\bcap\\.?\\s*\\d/i.test(norm(el.innerText) + ' ' + (el.getAttribute('href') || ''))
    return r.width > 0 && r.height > 0 && !off && !chapter
  }
  const all = [...document.querySelectorAll('a, button, [role="button"]')].filter(usable)
  const label = (el) => norm(el.getAttribute('aria-label') || el.getAttribute('title'))
  // A pager's own number first: on some ("1 2 … 10 Next") "Next" jumps to the next ten pages.
  const inPager = (el) =>
    /[?&/](page|pagina|p)[=/-]?\\d/i.test(el.getAttribute('href') || '') ||
    !!el.closest('[class*="paginat" i], [class*="pager" i], [aria-label*="pagination" i]')
  const pick =
    all.find((el) => el.getAttribute('rel') === 'next') ||
    all.find((el) => norm(el.innerText) === String(want) && inPager(el)) ||
    all.find((el) => /^(next|próxim[ao]|seguinte)( page| página)?$/i.test(label(el))) ||
    all.find((el) => /^(next|próxim[ao]|seguinte|›|»|>|>>|→)( page| página)?$/i.test(norm(el.innerText))) ||
    all.find((el) => norm(el.innerText) === String(want))
  if (!pick) return null
  const href = pick.href
  if (pick.tagName === 'A' && href && !href.startsWith('javascript') && href.split('#')[0] !== location.href.split('#')[0]) return { href }
  pick.click()
  return { clicked: true }
}`

async function mangadexChapters(source: string): Promise<ChapterLink[]> {
  const id = mangadexId(source)
  if (!id) return []
  const found = new Map<number, string>()
  for (let offset = 0; offset < MANGADEX_MAX_CHAPTERS; offset += MANGADEX_PAGE) {
    const feed = (await getJson(
      `${MANGADEX}/manga/${id}/feed?limit=${MANGADEX_PAGE}&offset=${offset}&order[chapter]=asc&translatedLanguage[]=en&${MANGADEX_RATINGS}`
    )) as MangadexFeed
    for (const c of feed.data) {
      const chapter = parseFloat(c.attributes.chapter ?? '')
      // Chapters on official sites are only links there, with no pages to translate.
      if (Number.isNaN(chapter) || c.attributes.externalUrl || found.has(chapter)) continue
      found.set(chapter, `https://mangadex.org/chapter/${c.id}`)
    }
    if (offset + MANGADEX_PAGE >= feed.total) break
  }
  return [...found].map(([chapter, url]) => ({ chapter, url })).sort((a, b) => a.chapter - b.chapter)
}

/** The newest chapter of a MangaDex work in English or Portuguese, from its API. */
export async function mangadexLatest(source: string): Promise<{ chapter: number; url: string } | null> {
  const id = mangadexId(source)
  if (!id) return null
  const feed = (await getJson(`${MANGADEX}/manga/${id}/feed?limit=50&order[chapter]=desc&${MANGADEX_LANGUAGES}&${MANGADEX_RATINGS}`)) as MangadexFeed
  let best: { chapter: number; url: string } | null = null
  for (const c of feed.data) {
    const chapter = parseFloat(c.attributes.chapter ?? '')
    if (Number.isNaN(chapter) || (best && best.chapter >= chapter)) continue
    best = {
      chapter,
      url: c.attributes.externalUrl ?? `https://mangadex.org/chapter/${c.id}`
    }
  }
  return best
}

const mangadexId = (url: string): string | null => /mangadex\.org\/title\/([0-9a-f-]{36})/i.exec(url)?.[1] ?? null

interface MangadexFeed {
  data: {
    id: string
    attributes: { chapter: string | null; externalUrl: string | null }
  }[]
  total: number
}

interface MangadexManga {
  id: string
  attributes: {
    title: Record<string, string>
    altTitles: Record<string, string>[]
    lastChapter: string | null
  }
  relationships: { type: string; attributes?: { fileName?: string } }[]
}

async function searchMangadex(query: string): Promise<CatalogMatch[]> {
  const found = (await getJson(`${MANGADEX}/manga?title=${encodeURIComponent(query)}&limit=8&includes[]=cover_art&${MANGADEX_RATINGS}`)) as {
    data: MangadexManga[]
  }
  return found.data.map((m) => {
    const titles = Object.values(m.attributes.title)
    const title = m.attributes.title.en ?? titles[0] ?? ''
    const file = m.relationships.find((r) => r.type === 'cover_art')?.attributes?.fileName
    return {
      site: 'mangadex',
      title,
      url: `https://mangadex.org/title/${m.id}`,
      cover: file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.512.jpg` : null,
      altNames: [...titles.filter((t) => t !== title), ...m.attributes.altTitles.flatMap((a) => Object.values(a))],
      latest: parseFloat(m.attributes.lastChapter ?? '') || null
    }
  })
}

async function searchMgeko(win: BrowserWindow, query: string): Promise<CatalogMatch[]> {
  await load(win, `https://www.mgeko.cc/search/?search=${encodeURIComponent(query)}`)
  const items = (await win.webContents.executeJavaScript(`[...document.querySelectorAll('li.novel-item')].map((li) => {
    const a = li.querySelector('a[href]')
    const img = li.querySelector('img')
    const src = img && (img.dataset.src || img.src)
    return {
      url: a ? a.href : '',
      title: ((li.querySelector('.novel-title') || {}).innerText || (a && a.title) || '').trim(),
      cover: src ? new URL(src, location.href).href : null,
      chapters: ((li.querySelector('.novel-stats strong') || {}).innerText || '').trim()
    }
  })`)) as {
    url: string
    title: string
    cover: string | null
    chapters: string
  }[]
  // Its pages list other names all in one line split by commas, which names also have: those are left out.
  return items
    .filter((i) => i.url && i.title)
    .map((i) => ({
      site: 'mgeko',
      title: i.title,
      url: i.url,
      cover: i.cover,
      altNames: [],
      latest: firstNumber(i.chapters)
    }))
}

/** The cover as a JPEG small enough for the library, fetched like the sites' own pages fetch it. */
async function downloadCover(url: string): Promise<Buffer | null> {
  const response = await session.fromPartition(PARTITION).fetch(url, { headers: { Referer: new URL(url).origin + '/' } })
  if (!response.ok) return null
  const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
  if (image.isEmpty()) return null
  const { width } = image.getSize()
  return (width > COVER_WIDTH ? image.resize({ width: COVER_WIDTH, quality: 'good' }) : image).toJPEG(85)
}

async function getJson(url: string): Promise<unknown> {
  const response = await session.fromPartition(PARTITION).fetch(url)
  if (!response.ok) throw new Error(`O site respondeu ${response.status}.`)
  return response.json()
}

/** Opens a page, waiting out a bot check that passes on its own. */
async function load(win: BrowserWindow, url: string): Promise<void> {
  await open(win, url)
  for (let waited = 0; await isChallenged(win); waited += 1_000) {
    if (waited > 20_000) throw new Error('O site pediu uma verificação: abra-o uma vez pelo "Abrir link" do app para passar.')
    await sleep(1_000)
  }
}

async function attempt(site: CatalogSite, search: () => Promise<CatalogMatch[]>): Promise<CatalogResult> {
  try {
    return { site, matches: await search() }
  } catch (err) {
    return { site, matches: [], error: (err as Error).message }
  }
}

async function withWindow<T>(win: BrowserWindow | undefined, run: (win: BrowserWindow) => Promise<T>): Promise<T> {
  if (win) return run(win)
  const own = hiddenWindow()
  try {
    return await run(own)
  } finally {
    if (!own.isDestroyed()) own.destroy()
  }
}

function firstNumber(text: string): number | null {
  const n = /\d+(?:\.\d+)?/.exec(text)
  return n ? parseFloat(n[0]) : null
}
