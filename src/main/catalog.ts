import { nativeImage, session, type BrowserWindow } from 'electron'
import { isSameWork, readableNames, type CatalogMatch, type CatalogResult, type CatalogSite } from '../shared/catalog'
import { chapterLinks, type ChapterLink, type PageLink } from '../shared/updates'
import { formatOf, normalizeName, type Work } from '../shared/works'
import { applyCatalog, listWorks } from './library'
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
const COVER_WIDTH = 300
const MANGADEX_PAGE = 500
const MANGADEX_MAX_CHAPTERS = 5_000
const CHOICES_PER_SITE = 5

const SEARCHES: Record<CatalogSite, (win: BrowserWindow, query: string) => Promise<CatalogMatch[]>> = {
  mangadex: (_win, query) => searchMangadex(query),
  mgeko: searchMgeko
}

/** Looks the name up on the catalog sites (all by default); a site that fails says why and leaves the others. */
export async function searchCatalog(
  query: string,
  win?: BrowserWindow,
  sites = Object.keys(SEARCHES) as CatalogSite[]
): Promise<CatalogResult[]> {
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
          return jpeg ? { ...m, thumb: `data:image/jpeg;base64,${jpeg.toString('base64')}` } : m
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
export async function chapterList(match: Pick<CatalogMatch, 'site' | 'url'>): Promise<ChapterLink[]> {
  if (match.site === 'mangadex') return mangadexChapters(match.url)
  return withWindow(undefined, async (w) => {
    await load(w, new URL('all-chapters/', match.url.endsWith('/') ? match.url : `${match.url}/`).href)
    // The page's list holds this work's chapters only, older ones under another name in their links.
    const links = (await w.webContents.executeJavaScript(
      `[...document.querySelectorAll('.chapter-list a[href]')].map((a) => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 120) }))`
    )) as PageLink[]
    return chapterLinks(match.url, links, true)
  })
}

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
    best = { chapter, url: c.attributes.externalUrl ?? `https://mangadex.org/chapter/${c.id}` }
  }
  return best
}

const mangadexId = (url: string): string | null => /mangadex\.org\/title\/([0-9a-f-]{36})/i.exec(url)?.[1] ?? null

interface MangadexFeed {
  data: { id: string; attributes: { chapter: string | null; externalUrl: string | null } }[]
  total: number
}

interface MangadexManga {
  id: string
  attributes: { title: Record<string, string>; altTitles: Record<string, string>[]; lastChapter: string | null }
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
      cover: file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.256.jpg` : null,
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
  })`)) as { url: string; title: string; cover: string | null; chapters: string }[]
  // Its pages list other names all in one line split by commas, which names also have: those are left out.
  return items
    .filter((i) => i.url && i.title)
    .map((i) => ({ site: 'mgeko', title: i.title, url: i.url, cover: i.cover, altNames: [], latest: firstNumber(i.chapters) }))
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
