import { nativeImage, session, type BrowserWindow } from 'electron'
import { isLikelySameWork, isSameWork, readableNames, type CatalogMatch, type CatalogResult, type CatalogSite } from '../shared/catalog'
import { displayName } from '../shared/works'
import { chapterLinks, fillChapterGaps, linksScript, sourceFromChapter, type ChapterLink, type PageLink } from '../shared/updates'
import { formatOf, normalizeName, sameName, type Work, type WorkInfo } from '../shared/works'
import { applyCatalog, hasWorkCover, listLibrary, listWorks, saveWorkCover, saveWorkInfo } from './library'
import { listReading } from './reading'
import { getSettings } from './settings'
import { askModel } from './translate'
import { parseLenient } from './translate/json'
import { signInIfAsked } from './siteLogins'
import { hiddenWindow, isChallenged, open, PARTITION, sleep } from './webChapter'

const MANGADEX = 'https://api.mangadex.org'
/** How the app names itself to APIs that turn browsers away. */
export const API_AGENT = 'ToonIndex/1.0'
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
/** A bot check still up after this long is shown to the person, who has this long to pass it. */
const CHALLENGE_SHOW_MS = 5_000
const CHALLENGE_TIMEOUT_MS = 120_000
const MANGADEX_PAGE = 500
const MANGADEX_MAX_CHAPTERS = 5_000
const CHOICES_PER_SITE = 5
/** Other names of the work a site that found nothing is asked by, at most. */
const OTHER_NAMES = 4

const SEARCHES: Record<CatalogSite, (win: BrowserWindow, query: string) => Promise<CatalogMatch[]>> = {
  mangadex: (_win, query) => searchMangadex(query),
  mgeko: searchMgeko,
  mangakakalot: searchMangakakalot,
  mangalivre: searchMangalivre
}

/** Catalog sites in Portuguese: their chapters are downloaded as they are. */
const PORTUGUESE_SITES = new Set<CatalogSite>(['mangalivre'])

/** Looks the name up on the catalog sites (all by default); a site that fails says why and leaves the others. */
/** What one catalog site answered. */
type SiteResult = CatalogResult & { site: CatalogSite }

export async function searchCatalog(query: string, win?: BrowserWindow, sites = Object.keys(SEARCHES) as CatalogSite[]): Promise<SiteResult[]> {
  const name = query.trim()
  if (!name) return []
  return withWindow(win, async (w) => {
    const results: SiteResult[] = []
    for (const site of sites) results.push(await attempt(site, () => SEARCHES[site](w, name)))
    // A site may know the work by another of its names only (mgeko has "Solo Spell Caster", not "The
    // Lone Spellcaster"): it is asked again by the names the other sites give the same work.
    const known = results.flatMap((r) => r.matches).filter((m) => isLikelySameWork([name], m))
    const others = [...new Set(readableNames(known.flatMap((m) => [...m.altNames, m.title])))].filter((n) => !sameName(n, name)).slice(0, OTHER_NAMES)
    // A site in Portuguese knows it by its Portuguese name ("Ponto de Vista do Leitor Onisciente"), and its
    // search answers anything: asked by those first, while nothing it gave is the work.
    const ptNames = [...new Set(readableNames(known.flatMap((m) => m.ptNames ?? [])))].filter((n) => !sameName(n, name)).slice(0, OTHER_NAMES)
    const names = [name, ...others, ...ptNames]
    for (const result of results) {
      if (result.error) continue
      const portuguese = PORTUGUESE_SITES.has(result.site)
      if (result.matches.length && (!portuguese || result.matches.some((m) => isLikelySameWork(names, m)))) continue
      for (const other of portuguese ? [...ptNames, ...others] : others) {
        const again = await attempt(result.site, () => SEARCHES[result.site](w, other))
        if (again.matches.length && (!portuguese || again.matches.some((m) => isLikelySameWork(names, m)))) {
          result.matches = again.matches
          break
        }
      }
    }
    return results
  })
}

/**
 * The search for the person to choose from: the first results of each site, with their covers. With
 * `own`, the person's own Portuguese sites too ("Vários capítulos": a scan in Portuguese to download).
 */
export async function searchCatalogToChoose(query: string, own = false): Promise<CatalogResult[]> {
  const results: CatalogResult[] = await searchCatalog(query)
  if (own) results.push(await searchOwnSites(query, results))
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
      sites: matches.map((m) => m.site).filter((s): s is CatalogSite => s !== 'link'),
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
  const match = await mangadexByNamesElsewhere(work)
  return match?.cover ? await downloadCover(match.cover).catch(() => null) : null
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
 * "Atualizar dados": the work's cover, the name it is shown by, synopsis, tags, status and year from
 * MangaDex; what MangaDex lacks (or the whole, for works it does not have) from the work's page on the
 * site its chapters come from.
 */
export async function refreshWork(workId: string): Promise<Work[]> {
  const work = listWorks().find((w) => w.id === workId)
  if (!work) throw new Error('Obra não encontrada.')
  const mangadex = (work.sources ?? []).map(mangadexId).find((id): id is string => !!id) ?? (await findMangadexId(work))
  const details = mangadex ? await mangadexDetails(mangadex).catch(() => null) : null
  const pages = workPages(work).filter((p) => !mangadexId(p))
  const lacking = !details || !details.cover || !details.info.synopsis || !details.info.tags?.length
  const page = lacking && pages.length ? await withWindow(undefined, (w) => pageDetails(w, pages.slice(0, 2))) : null
  if (!details && !page) {
    throw new Error('Não achei a obra no MangaDex nem uma página dela num site: adicione o site dela em "Editar obra" e tente de novo.')
  }
  const info: WorkInfo = {
    ...page?.info,
    ...details?.info,
    synopsis: details?.info.synopsis || page?.info.synopsis,
    tags: details?.info.tags?.length ? details.info.tags : page?.info.tags,
    from: details?.info.from ?? page!.info.from,
    updatedAt: Date.now()
  }
  return saveWorkInfo(workId, {
    // Shown first: its name in the language chapters are translated into (Configurações). Else its
    // English one only when translating into English, or in place of the same name written otherwise
    // ("solo spell caster"): a work known here by its Portuguese name keeps it, the English ones after.
    title:
      details?.title && (details.inLanguage || getSettings().targetLanguage === 'English' || sameName(work.names[0], details.title)) ? details.title : null,
    names: readableNames([...(details?.names ?? []), ...(page?.names ?? [])]),
    // Its MangaDex page once, however its link was written.
    sources: mangadex && !(work.sources ?? []).some((s) => mangadexId(s) === mangadex) ? [`https://mangadex.org/title/${mangadex}`] : [],
    sites: mangadex ? ['mangadex'] : [],
    cover: details?.cover ?? page?.cover ?? null,
    info
  })
}

/** The work's pages on sites: the ones set for it, then the ones its chapters were read or saved from. */
function workPages(work: Work): string[] {
  const read = listReading()
    .filter((r) => r.workId === work.id && r.url)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((r) => r.url)
  const saved = listLibrary()
    .filter((e) => e.workId === work.id && e.source)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => e.source!)
  const fromChapters = [...read, ...saved].map((u) => (mangadexId(u) ? u : sourceFromChapter(u))).filter((p): p is string => !!p)
  return [...new Set([...(work.sources ?? []), ...fromChapters])]
}

async function findMangadexId(work: Work): Promise<string | null> {
  if (formatOf(work) !== 'comic') return null
  for (const name of readableNames(work.names).slice(0, AUTO_SEARCHES)) {
    const match = (await searchMangadex(name).catch(() => [])).find((m) => isLikelySameWork(work.names, m))
    if (match) return mangadexId(match.url)
  }
  const match = await mangadexByNamesElsewhere(work)
  return match ? mangadexId(match.url) : null
}

/** By work id, the names found for it elsewhere (looked up once per run of the app). */
const namesAsked = new Map<string, Promise<string[]>>()

/**
 * The work's names elsewhere, for one known here by its Portuguese name only (the scans' own:
 * "Acham que eu sou um gênio do futebol" is "I'm Not a Soccer Genius!"). The name is searched on the
 * web, and the results' titles are the candidates, with what the AI set for translating reads in them
 * ("also known as …"). MangaDex then has to carry one of them exactly for it to count.
 */
function namesElsewhere(work: Work): Promise<string[]> {
  let asked = namesAsked.get(work.id)
  if (!asked) {
    asked = (async () => {
      const kind = work.format === 'novel' ? 'novel' : 'manhwa'
      const results = await webSearch(`${work.names[0]} ${kind}`).catch(() => [])
      const known = new Set(work.names.map(normalizeName))
      // "I'm Not a Soccer Genius! - WEBTOON": a result's title without the site it is on.
      const titled = results.filter((r) => r.title !== 'Visão geral criada por IA').flatMap((r) => r.title.split(/\s+[|–—-]\s+/).slice(0, 1)).map((t) => t.replace(/\s+(?:cap(?:[ií]tulo)?|chapter|ch\.?)\s*\d.*$/i, '').trim())
      let read: string[] = []
      if (results.length) {
        const prompt =
          `These are web search results for the ${kind} published in Portuguese as "${work.names[0]}":\n\n` +
          results.map((r) => `- ${r.title}: ${r.snippet}`).join('\n') +
          '\n\nFrom these results (and what you know of the work), give its official English title and other English titles, ' +
          'its original title (Korean, Japanese or Chinese) and its romanization. Do not translate the Portuguese title yourself. ' +
          'Answer with JSON only: {"names": ["...", "..."]}, or {"names": []} if they do not say.'
        read = await askModel(prompt)
          .then((raw) => {
            const names = (parseLenient(raw) as { names?: unknown })?.names
            return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
          })
          .catch(() => [])
      }
      const seen = new Set<string>()
      return [...read, ...titled]
        .map((n) => n.trim())
        .filter((n) => n.length > 1 && n.length <= 150 && !known.has(normalizeName(n)) && !seen.has(normalizeName(n)) && seen.add(normalizeName(n)))
        .slice(0, 8)
    })()
    namesAsked.set(work.id, asked)
  }
  return asked
}

/**
 * A Google search's results (titles and the text under them) and its AI overview, read in a hidden
 * window of the app's browser, as a person searching sees them. A bot check ends it with nothing.
 */
async function webSearch(query: string): Promise<{ title: string; snippet: string }[]> {
  return withWindow(undefined, async (w) => {
    await load(w, `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=pt-BR`)
    await sleep(2_500)
    if (await isChallenged(w)) return []
    return (await w.webContents.executeJavaScript(GOOGLE_RESULTS)) as { title: string; snippet: string }[]
  })
}

/** Runs in Google's results: the AI overview first (when there is one), then each result's title and the text under it. */
const GOOGLE_RESULTS = `(() => {
  if (location.pathname.startsWith('/sorry')) return []
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const out = []
  const ai = (document.body.innerText.match(/(?:Visão geral criada por IA|AI Overview)([\\s\\S]{0,1200})/) || [])[1]
  if (ai) out.push({ title: 'Visão geral criada por IA', snippet: norm(ai) })
  for (const h of document.querySelectorAll('h3')) {
    const block = h.closest('[data-hveid], .g, [data-snc]') || h.parentElement
    const snippet = norm(block?.innerText || '').replace(norm(h.innerText), '').slice(0, 300)
    out.push({ title: norm(h.innerText), snippet })
  }
  return out.filter((r) => r.title && r.title !== 'O Modo IA respondeu:').slice(0, 12)
})()`

/** MangaDex's entry carrying exactly one of the work's names found elsewhere (searched in any script: MangaDex knows the original titles). */
async function mangadexByNamesElsewhere(work: Work): Promise<CatalogMatch | null> {
  const names = await namesElsewhere(work)
  for (const name of names) {
    const found = await searchMangadex(name).catch(() => [])
    const match = found.find((m) => isSameWork(names, m))
    if (match) return match
  }
  return null
}

/** MangaDex's codes for the names of a work in each language chapters can be translated into. */
const TITLE_LANGUAGES: Record<string, string[]> = {
  'Brazilian Portuguese': ['pt-br', 'pt'],
  'European Portuguese': ['pt', 'pt-br'],
  English: ['en'],
  Spanish: ['es-la', 'es'],
  French: ['fr'],
  Italian: ['it'],
  German: ['de'],
  Russian: ['ru'],
  Indonesian: ['id'],
  Thai: ['th'],
  Vietnamese: ['vi'],
  Arabic: ['ar']
}

const MANGADEX_STATUS: Record<string, string> = { ongoing: 'Em andamento', completed: 'Completo', hiatus: 'Em hiato', cancelled: 'Cancelado' }

/** MangaDex's tags, as Portuguese readers know them. */
const TAGS_PT: Record<string, string> = {
  Action: 'Ação',
  Adventure: 'Aventura',
  Comedy: 'Comédia',
  Drama: 'Drama',
  Fantasy: 'Fantasia',
  Horror: 'Terror',
  Mystery: 'Mistério',
  Romance: 'Romance',
  'Sci-Fi': 'Ficção científica',
  'Slice of Life': 'Cotidiano',
  Sports: 'Esportes',
  Thriller: 'Suspense',
  Tragedy: 'Tragédia',
  Psychological: 'Psicológico',
  Historical: 'Histórico',
  'Martial Arts': 'Artes marciais',
  Magic: 'Magia',
  'Time Travel': 'Viagem no tempo',
  Reincarnation: 'Reencarnação',
  Isekai: 'Isekai',
  Monsters: 'Monstros',
  Demons: 'Demônios',
  Supernatural: 'Sobrenatural',
  'School Life': 'Vida escolar',
  'Video Games': 'Videogames',
  'Survival': 'Sobrevivência',
  'Long Strip': 'Webtoon',
  'Full Color': 'Colorido',
  'Web Comic': 'Web comic',
  Adaptation: 'Adaptação',
  Military: 'Militar',
  Villainess: 'Vilã',
  Wuxia: 'Wuxia'
}

/** A MangaDex work's name, in the language chapters are translated into when it has one there, else in English. */
async function mangadexTitle(id: string): Promise<string | null> {
  const { data } = (await getJson(`${MANGADEX}/manga/${id}`)) as { data: MangadexManga }
  const { title, altTitles } = data.attributes
  const alt = (lang: string) => title[lang] ?? altTitles.find((a) => a[lang])?.[lang]
  return TITLE_LANGUAGES[getSettings().targetLanguage]?.map(alt).find(Boolean) ?? alt('en') ?? Object.values(title)[0] ?? null
}

async function mangadexDetails(id: string): Promise<{ title: string | null; inLanguage: boolean; names: string[]; cover: Buffer | null; info: WorkInfo }> {
  const { data } = (await getJson(`${MANGADEX}/manga/${id}?includes[]=cover_art`)) as {
    data: MangadexManga & {
      attributes: {
        description: Record<string, string>
        status: string | null
        year: number | null
        tags: { attributes: { name: Record<string, string>; group: string } }[]
      }
    }
  }
  const { title, altTitles, description, status, year, tags } = data.attributes
  const alt = (lang: string) => title[lang] ?? altTitles.find((a) => a[lang])?.[lang]
  const file = data.relationships.find((r) => r.type === 'cover_art')?.attributes?.fileName
  const cover = file ? await downloadCover(`https://uploads.mangadex.org/covers/${id}/${file}.512.jpg`).catch(() => null) : null
  const synopsis = cleanSynopsis(description['pt-br'] || description.en || '')
  return {
    // In the language chapters are translated into when it has a name in it, else in English.
    title: TITLE_LANGUAGES[getSettings().targetLanguage]?.map(alt).find(Boolean) ?? alt('en') ?? null,
    inLanguage: !!TITLE_LANGUAGES[getSettings().targetLanguage]?.map(alt).find(Boolean),
    names: [...Object.values(title), ...altTitles.flatMap((a) => Object.values(a))],
    cover,
    info: {
      ...(synopsis && { synopsis }),
      tags: tags
        .filter((t) => t.attributes.group !== 'content')
        .map((t) => t.attributes.name.en)
        .filter(Boolean)
        .map((t) => TAGS_PT[t] ?? t),
      ...(status && { status: MANGADEX_STATUS[status] ?? status }),
      ...(year && { year }),
      from: `https://mangadex.org/title/${id}`,
      updatedAt: Date.now()
    }
  }
}

/** MangaDex's descriptions in Markdown: links to plain text, the notes after a rule or "Links:" left out. */
function cleanSynopsis(text: string): string {
  return text
    .split(/\n\s*(?:---+|\*\*\*+|___+)\s*\n|\n\s*\**(?:links?|official|raw)\**\s*:/i)[0]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** What the work's page on a site says of it: its name, synopsis, genres and cover. */
async function pageDetails(win: BrowserWindow, pages: string[]): Promise<{ names: string[]; cover: Buffer | null; info: WorkInfo } | null> {
  for (const page of pages) {
    try {
      await load(win, page)
      await sleep(SETTLE_MS)
      const found = (await win.webContents.executeJavaScript(PAGE_DETAILS)) as { title: string; synopsis: string; tags: string[] }
      const cover = await pageCover(win, [page])
      if (!found.synopsis && !found.tags.length && !cover) continue
      return {
        names: found.title ? [found.title] : [],
        cover,
        info: {
          ...(found.synopsis && { synopsis: found.synopsis }),
          ...(found.tags.length && { tags: found.tags }),
          from: page,
          updatedAt: Date.now()
        }
      }
    } catch {
      // The next page.
    }
  }
  return null
}

/** Runs in a work's page: its title (without the site's name), the longest synopsis it has, and its genre links. */
const PAGE_DETAILS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const meta = (s) => norm(document.querySelector(s)?.content)
  // Some sites put only their own name there ("MangaFire - Read Manga Online Free"): the next that is not it.
  const site = location.hostname.replace(/^www\\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase()
  // Its name, one the address starts the same way as ("MediocreToons" on mediocrescan.com), or the one it gives itself.
  const own = meta('meta[property="og:site_name"]').replace(/[^a-z0-9]/gi, '').toLowerCase()
  const isSite = (s) => {
    const key = s.replace(/[^a-z0-9]/gi, '').toLowerCase()
    return key === site || key === own || (!/\\s/.test(s) && key.length >= 6 && site.length >= 6 && key.slice(0, 6) === site.slice(0, 6))
  }
  const title = [meta('meta[property="og:title"]'), document.querySelector('h1')?.innerText, document.title]
    .map((s) => norm((s || '').split(/\\s+[|–—-]\\s+/)[0]))
    .find((s) => s && !isSite(s)) || ''
  const blocks = [...document.querySelectorAll('[class*="summary" i], [class*="synopsis" i], [class*="sinopse" i], [class*="description" i], [id*="summary" i], [id*="synopsis" i], [itemprop="description"]')]
    .map((el) => (el.innerText || '').trim())
    .filter((t) => t.length > 40 && t.length < 4000)
  const synopsis = [meta('meta[property="og:description"]'), meta('meta[name="description"]'), ...blocks].sort((a, b) => b.length - a.length)[0] || ''
  const tags = [...new Set([...document.querySelectorAll('a[href*="genre" i], a[href*="genero" i], a[href*="/tag/" i], a[href*="/tags/" i]')]
    .map((a) => norm(a.innerText))
    .filter((t) => t && t.length < 25))].slice(0, 12)
  return { title, synopsis, tags }
})()`

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
  if (!picks.size && formatOf(work) === 'comic') {
    const match = await mangadexByNamesElsewhere(work)
    if (match) {
      picks.set('mangadex', match)
      // The other sites go by its English names: asked by them too.
      const english = readableNames([match.title, ...match.altNames]).slice(0, OTHER_NAMES)
      for (const query of english) {
        const missing = (Object.keys(SEARCHES) as CatalogSite[]).filter((s) => !picks.has(s))
        if (!missing.length) break
        for (const result of await searchCatalog(query, win, missing)) {
          const found = result.matches.find((m) => isSameWork(english, m))
          if (found) picks.set(result.site, found)
        }
      }
    }
  }
  return { picks: [...picks.values()], failed }
}

/**
 * Every chapter of the work on its site, in order, for translating a range of them, and the work's name
 * as its page gives it (for a link pasted without one). MangaDex's are the English ones it hosts (not
 * links to official sites); mgeko lists them all on one page.
 */
export async function chapterList(match: { site: CatalogSite | 'link'; url: string }): Promise<{ title: string | null; chapters: ChapterLink[]; language?: string | null }> {
  // A pasted MangaDex link too: its site lists the chapters a page at a time, the API all of them.
  const id = mangadexId(match.url)
  if (match.site === 'mangadex' || id) {
    const [title, chapters] = await Promise.all([id ? mangadexTitle(id).catch(() => null) : null, mangadexChapters(match.url)])
    return { title, chapters }
  }
  if (match.site === 'link') return pageChapters(match.url)
  if (match.site === 'mangakakalot') return mangakakalotChapters(match.url)
  if (match.site === 'mangalivre') return mangalivreChapters(match.url)
  return withWindow(undefined, async (w) => {
    await load(w, new URL('all-chapters/', match.url.endsWith('/') ? match.url : `${match.url}/`).href)
    // The page's list holds this work's chapters only, older ones under another name in their links.
    const links = (await w.webContents.executeJavaScript(linksScript('.chapter-list a[href]'))) as PageLink[]
    return { title: null, chapters: chapterLinks(match.url, links, true) }
  })
}

/** Any site: the chapters linked from the work's page, scrolled to the end for lists that load as they show. */
async function pageChapters(url: string): Promise<{ title: string | null; chapters: ChapterLink[]; language: string | null }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Cole o link da página da obra (o que começa com https://).')
  return withWindow(undefined, async (w) => {
    await load(w, url)
    // After the wait: some sites only send to their sign-in page once the page's script has run.
    await sleep(SETTLE_MS)
    if (/\/(entrar|login|signin|sign-in|auth)\b/i.test(new URL(w.webContents.getURL()).pathname)) {
      throw new Error('O site pediu login: clique em "Entrar no site", entre com a sua conta e tente de novo.')
    }
    // Read before the list's pages, which can take the window to other addresses.
    const { title } = (await w.webContents.executeJavaScript(PAGE_DETAILS).catch(() => ({ title: '' }))) as { title: string }
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
    // The page's language: a scan already in Portuguese is downloaded, not translated.
    const language = ((await w.webContents.executeJavaScript('document.documentElement.lang || ""').catch(() => '')) as string) || null
    return { title: workTitle(title), chapters: fillChapterGaps(chapterLinks(url, [...seen.values()])), language }
  })
}

/** The person's own sites searched at most, the ones most of the library's works are followed on. */
const OWN_SITES = 4
/** Names a site is searched by at most, before it is taken not to have the work. */
const OWN_NAMES = 3
const CATALOG_HOSTS = /(^|\.)(mangadex\.org|mgeko\.cc|mangakakalot\.(?:fan|gg)|mangalivre\.blog)$/
/** Sites whose search box sends to an address: searched there straight away. */
const SEARCH_PAGES: Record<string, string> = { 'mediocrescan.com': '/pesquisar?busca={q}&pagina=1' }
/** The sites found not to be in Portuguese (or gone), left out of the next searches. */
const notPortuguese = new Set<string>()

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The work on the person's own sites in Portuguese: the pages the library already follows it on, and
 * the others searched by its names, the Portuguese ones first (a name searched in English finds
 * "Retornar ao Início do Apocalipse" on a Brazilian scan).
 */
async function searchOwnSites(query: string, results: CatalogResult[]): Promise<CatalogResult> {
  const name = query.trim()
  const same = results.flatMap((r) => r.matches).filter((m) => isLikelySameWork([name], m))
  const works = listWorks()
  const work =
    works.find((w) => w.names.some((n) => sameName(n, name) || same.some((m) => isSameWork([n], m)))) ?? null
  const names = [
    ...new Set(readableNames([...same.flatMap((m) => m.ptNames ?? []), ...(work?.names ?? []), name, ...same.flatMap((m) => [m.title, ...m.altNames])]))
  ]
  const matches: CatalogMatch[] = (work?.sources ?? [])
    .filter((s) => !CATALOG_HOSTS.test(hostOf(s)))
    .map((s) => ({ site: 'link', title: displayName(work!.names[0]), url: s, cover: null, altNames: [], latest: null }))
  // The sites most works are followed on, the work's own left out (it is there already).
  const counts = new Map<string, { origin: string; count: number }>()
  for (const w of works) {
    for (const s of w.sources ?? []) {
      const host = hostOf(s)
      if (!host || CATALOG_HOSTS.test(host) || notPortuguese.has(host) || matches.some((m) => hostOf(m.url) === host)) continue
      counts.set(host, { origin: new URL(s).origin, count: (counts.get(host)?.count ?? 0) + 1 })
    }
  }
  const sites = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, OWN_SITES)
  // Each in its own window, all at once: a site that fails or has nothing leaves the others.
  const found = await Promise.all(
    sites.map((s) =>
      searchOwnSite(s.origin, names).catch((err: Error) => {
        // A site that is gone (its address no longer found) is left out quietly, and next time.
        if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_ADDRESS/.test(err.message)) {
          notPortuguese.add(hostOf(s.origin))
          return []
        }
        return { error: `${hostOf(s.origin)}: ${err.message}` }
      })
    )
  )
  const errors = found.flatMap((f) => ('error' in f ? [f.error] : []))
  return {
    site: 'sites',
    matches: [...matches, ...found.flatMap((f) => ('error' in f ? [] : f))],
    ...(errors.length && { error: errors.join(' · ') })
  }
}

/** One of the person's sites searched by the work's names, when it is in Portuguese. */
async function searchOwnSite(origin: string, names: string[]): Promise<CatalogMatch[]> {
  const host = hostOf(origin)
  return withWindow(undefined, async (w) => {
    await load(w, `${origin}/`)
    await sleep(SETTLE_MS)
    // Sites that send to their sign-in page once their script has run: in with the account in site-logins.env.
    if (await signInIfAsked(w, `${origin}/`, (u) => open(w, u))) await sleep(SETTLE_MS)
    if (/\/(entrar|login|signin|sign-in|auth)\b/i.test(new URL(w.webContents.getURL()).pathname)) {
      throw new Error('o site pede login (ponha a conta no arquivo de contas, em Configurações, ou entre pelo "Entrar no site")')
    }
    const language = (await w.webContents.executeJavaScript('document.documentElement.lang || ""')) as string
    if (language && !/^pt/i.test(language)) {
      notPortuguese.add(host)
      return []
    }
    for (const name of names.slice(0, OWN_NAMES)) {
      const page = SEARCH_PAGES[host]
      if (page) await load(w, origin + page.replace('{q}', encodeURIComponent(name)))
      else if (!(await w.webContents.executeJavaScript(`(${TYPE_SEARCH})(${JSON.stringify(name)})`))) return []
      await sleep(SETTLE_MS)
      const links = (await w.webContents.executeJavaScript(WORK_LINKS)) as { url: string; texts: string[]; cover: string | null }[]
      // A card's texts hold its name among its numbers ("313", "9,7"): the one that is the work's.
      const hits = links.flatMap((l) => {
        const title = l.texts.filter((t) => isLikelySameWork(names, { title: t, altNames: [] })).sort((x, y) => x.length - y.length)[0]
        return title ? [{ site: 'link' as const, title, url: l.url, cover: l.cover, altNames: [], latest: null }] : []
      })
      if (hits.length) return hits.slice(0, 3)
    }
    return []
  })
}

/** Types the name in the site's search box (opened first when a button hides it) and sends it. */
const TYPE_SEARCH = String.raw`async (name) => {
  const shown = (el) => el.getClientRects().length > 0
  const words = /search|busca|pesquis|procur/i
  const isBox = (i) => i.type === 'search' || words.test([i.name, i.placeholder, i.id, i.getAttribute('aria-label') || ''].join(' ')) || /^(s|q)$/.test(i.name)
  const box = () => [...document.querySelectorAll('input')].filter(isBox).sort((a, b) => shown(b) - shown(a))[0]
  let input = box()
  if (!input || !shown(input)) {
    const button = [...document.querySelectorAll('button, a, [role=button]')].find((b) => shown(b) && words.test([b.getAttribute('aria-label') || '', b.title || '', String(b.className || ''), b.textContent || ''].join(' ')))
    if (button) {
      button.click()
      await new Promise((r) => setTimeout(r, 800))
      input = box() || input
    }
  }
  if (!input) return false
  input.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 400))
  for (const type of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  if (input.form) input.form.requestSubmit ? input.form.requestSubmit() : input.form.submit()
  return true
}`

/** The works linked from a page of results: their pages (not a chapter's), names and covers. */
const WORK_LINKS = String.raw`(() => {
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const chapter = /(cap[ií]tulo|chapter|\bch\b|\bcap\b|episod)/i
  const found = new Map()
  for (const a of document.querySelectorAll('a[href]')) {
    let url
    try {
      url = new URL(a.href, location.href)
    } catch {
      continue
    }
    const path = decodeURIComponent(url.pathname)
    if (url.origin !== location.origin || !/\/(obras?|mang[aá]s?|manhwas?|manhuas?|series|s[eé]ries?|titles?|comics?|webtoons?|novels?)\/[^/]+/i.test(path) || chapter.test(path.replace(/[-_/]/g, ' '))) continue
    const img = a.querySelector('img')
    const src = img && (img.currentSrc || img.src || img.dataset.src || null)
    // Its texts: the whole card's, each piece of it, its image's name and its tooltip.
    const leaves = [...a.querySelectorAll('*')].filter((el) => !el.children.length).map(text)
    const texts = [text(a), ...leaves, a.title, img && img.alt].map((s) => (s || '').trim()).filter((s) => s.length >= 2 && s.length <= 150 && !chapter.test(s))
    const key = url.origin + url.pathname.replace(/\/$/, '')
    const known = found.get(key)
    if (!known) found.set(key, { url: key, texts, cover: src && !src.startsWith('data:') ? src : null })
    else {
      known.texts.push(...texts)
      if (!known.cover && src && !src.startsWith('data:')) known.cover = src
    }
  }
  return [...found.values()].filter((l) => l.texts.length)
})()`

/** A page's title without what sites add to it: the last chapter ("[Ch. 229]"), "Read … Online", "Manga". */
function workTitle(title: string): string | null {
  const name = title
    .replace(/[[(]\s*(?:ch|chap|chapter|cap|capítulo|ep)\b[^\])]*[\])]/gi, '')
    .replace(/\s+(?:chapter|cap[ií]tulo|ch\.?)\s*[\d.]+.*$/i, '')
    .replace(/^read\s+/i, '')
    .replace(/\s+(?:manga|manhwa|manhua|webtoon)?\s*(?:online|free|em português)?(?:\s+(?:online|free))?\s*$/i, '')
    .replace(/\s+(?:manga|manhwa|manhua)$/i, '')
    .trim()
  return name || null
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
  return (await w.webContents.executeJavaScript(linksScript())) as PageLink[]
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
  const found = new Map<number, ChapterLink>()
  for (let offset = 0; offset < MANGADEX_MAX_CHAPTERS; offset += MANGADEX_PAGE) {
    const feed = (await getJson(
      `${MANGADEX}/manga/${id}/feed?limit=${MANGADEX_PAGE}&offset=${offset}&order[chapter]=asc&translatedLanguage[]=en&${MANGADEX_RATINGS}`
    )) as MangadexFeed
    for (const c of feed.data) {
      const chapter = parseFloat(c.attributes.chapter ?? '')
      // Chapters on official sites are only links there, with no pages to translate.
      if (Number.isNaN(chapter) || c.attributes.externalUrl || found.has(chapter)) continue
      found.set(chapter, { chapter, url: `https://mangadex.org/chapter/${c.id}`, ...releaseOf(c) })
    }
    if (offset + MANGADEX_PAGE >= feed.total) break
  }
  return [...found.values()].sort((a, b) => a.chapter - b.chapter)
}

/** The newest chapter of a MangaDex work in English or Portuguese, from its API. */
/** When a MangaDex chapter came out. */
function releaseOf(c: MangadexFeed['data'][number]): { date?: number } {
  const t = Date.parse(c.attributes.publishAt ?? c.attributes.readableAt ?? '')
  return Number.isNaN(t) ? {} : { date: t }
}

export async function mangadexLatest(source: string): Promise<{ chapter: number; url: string; dates: Record<string, number> } | null> {
  const id = mangadexId(source)
  if (!id) return null
  const feed = (await getJson(`${MANGADEX}/manga/${id}/feed?limit=50&order[chapter]=desc&${MANGADEX_LANGUAGES}&${MANGADEX_RATINGS}`)) as MangadexFeed
  let best: { chapter: number; url: string } | null = null
  const dates: Record<string, number> = {}
  for (const c of feed.data) {
    const chapter = parseFloat(c.attributes.chapter ?? '')
    const { date } = releaseOf(c)
    if (!Number.isNaN(chapter) && date && (!dates[chapter] || date < dates[chapter])) dates[chapter] = date
    if (Number.isNaN(chapter) || (best && best.chapter >= chapter)) continue
    best = {
      chapter,
      url: c.attributes.externalUrl ?? `https://mangadex.org/chapter/${c.id}`
    }
  }
  return best && { ...best, dates }
}

const mangadexId = (url: string): string | null => /mangadex\.org\/title\/([0-9a-f-]{36})/i.exec(url)?.[1] ?? null

interface MangadexFeed {
  data: {
    id: string
    attributes: { chapter: string | null; externalUrl: string | null; publishAt?: string; readableAt?: string }
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
      // English names first: the other sites mostly go by them.
      altNames: [
        ...m.attributes.altTitles.filter((a) => a.en).map((a) => a.en),
        ...titles.filter((t) => t !== title),
        ...m.attributes.altTitles.filter((a) => !a.en).flatMap((a) => Object.values(a))
      ],
      latest: parseFloat(m.attributes.lastChapter ?? '') || null,
      ptNames: [m.attributes.title['pt-br'], ...m.attributes.altTitles.map((a) => a['pt-br'] ?? a.pt)].filter((n): n is string => !!n)
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

/** MangaKakalot's results page ("story_item"s): name, page, cover and newest chapter. */
async function searchMangakakalot(win: BrowserWindow, query: string): Promise<CatalogMatch[]> {
  // Its search takes the name as its links write it: "omniscient_reader".
  const word = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  await load(win, `https://www.mangakakalot.fan/home/search/json?searchword=${encodeURIComponent(word)}`)
  const items = (await win.webContents.executeJavaScript(`[...document.querySelectorAll('.story_item')].map((item) => {
    const a = item.querySelector('.story_name a[href]')
    const img = item.querySelector('img')
    return {
      url: a ? a.href : '',
      title: a ? a.innerText.trim() : '',
      cover: img ? img.src : null,
      chapter: ((item.querySelector('.story_chapter') || {}).innerText || '').trim()
    }
  })`)) as { url: string; title: string; cover: string | null; chapter: string }[]
  return items
    .filter((i) => i.url && i.title)
    .map((i) => ({ site: 'mangakakalot', title: i.title, url: i.url, cover: i.cover, altNames: [], latest: firstNumber(i.chapter) }))
}

/** MangaLivre's results page (in Portuguese): its "manga-card"s. */
async function searchMangalivre(win: BrowserWindow, query: string): Promise<CatalogMatch[]> {
  await load(win, `https://mangalivre.blog/?s=${encodeURIComponent(query)}`)
  const items = (await win.webContents.executeJavaScript(`[...document.querySelectorAll('a.manga-card-link[href]')].map((a) => {
    const img = a.querySelector('img')
    return {
      url: a.href,
      title: ((a.querySelector('.manga-card-title') || {}).innerText || (img && img.alt) || '').trim(),
      cover: img ? img.currentSrc || img.src : null,
      chapter: ((a.querySelector('.chapter-number') || {}).innerText || '').trim()
    }
  })`)) as { url: string; title: string; cover: string | null; chapter: string }[]
  return items
    .filter((i) => i.url && i.title)
    .map((i) => ({ site: 'mangalivre', title: i.title, url: i.url, cover: i.cover, altNames: [], latest: firstNumber(i.chapter) }))
}

/** Every chapter of a work on MangaLivre: its page shows 30, "Carregar mais capítulos" the rest. */
async function mangalivreChapters(url: string): Promise<{ title: string | null; chapters: ChapterLink[]; language: string }> {
  return withWindow(undefined, async (w) => {
    await load(w, url)
    await sleep(PAGE_SETTLE_MS)
    await w.webContents.executeJavaScript(`(async () => {
      const count = () => new Set([...document.querySelectorAll('a[href*="/capitulo/"]')].map((a) => a.href)).size
      for (let i = 0; i < 300; i++) {
        const more = document.querySelector('.chapters-load-more')
        if (!more || !more.getClientRects().length || more.disabled) break
        const before = count()
        more.click()
        for (let waited = 0; waited < 40 && count() === before; waited++) await new Promise((r) => setTimeout(r, 250))
        if (count() === before) break
      }
    })()`)
    // The work's chapters are at "/capitulo/<its slug>-…" (the page links others' too).
    const slug = new URL(url).pathname.split('/').filter(Boolean)[1] ?? ''
    const links = ((await w.webContents.executeJavaScript(linksScript('a[href*="/capitulo/"]'))) as PageLink[]).filter((l) =>
      decodeURIComponent(new URL(l.href).pathname).toLowerCase().startsWith(`/capitulo/${slug.toLowerCase()}-`)
    )
    // In Portuguese already: downloaded, not translated.
    return { title: null, chapters: chapterLinks(url, links, true), language: 'pt-BR' }
  })
}

/**
 * Every chapter of a work on MangaKakalot, from the list its page draws them from, oldest first. Asked
 * from the work's page itself: the site is behind Cloudflare, whose cookie only a page sends.
 */
async function mangakakalotChapters(url: string): Promise<{ title: string | null; chapters: ChapterLink[] }> {
  const page = new URL(url)
  const slug = page.pathname.split('/').filter(Boolean)[1]
  if (!slug) throw new Error('Link do MangaKakalot sem a obra.')
  const api = `${page.origin}/api/manga/${slug}/chapters?limit=5000&offset=0`
  const answer = await withWindow(undefined, async (w) => {
    await load(w, url)
    return (await w.webContents.executeJavaScript(
      `fetch(${JSON.stringify(api)}, { headers: { Accept: 'application/json' } }).then(async (r) => ({ status: r.status, text: await r.text() }))`
    )) as { status: number; text: string }
  })
  if (answer.status !== 200) throw new Error(`O MangaKakalot respondeu ${answer.status}.`)
  const body = JSON.parse(answer.text) as { data?: { chapters?: { chapter_name: string; chapter_slug: string; chapter_num: number; updated_at: string }[] } }
  const seen = new Set<number>()
  const chapters: ChapterLink[] = []
  for (const c of [...(body.data?.chapters ?? [])].reverse()) {
    if (!Number.isFinite(c.chapter_num) || seen.has(c.chapter_num)) continue
    seen.add(c.chapter_num)
    chapters.push({ chapter: c.chapter_num, url: `${page.origin}/manga/${slug}/${c.chapter_slug}`, ...(Date.parse(c.updated_at) && { date: Date.parse(c.updated_at) }) })
  }
  return { title: null, chapters: chapters.sort((a, b) => a.chapter - b.chapter) }
}

/** The cover as a JPEG small enough for the library, fetched like the sites' own pages fetch it. */
async function downloadCover(url: string): Promise<Buffer | null> {
  const host = new URL(url).hostname
  // MangaDex's covers, like its API, are refused to browsers.
  const agent = /(^|\.)mangadex\.org$/.test(host) ? { 'User-Agent': API_AGENT } : {}
  const response = await session.fromPartition(PARTITION).fetch(url, { headers: { Referer: new URL(url).origin + '/', ...agent } })
  if (!response.ok) return null
  const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
  if (image.isEmpty()) return null
  const { width } = image.getSize()
  return (width > COVER_WIDTH ? image.resize({ width: COVER_WIDTH, quality: 'good' }) : image).toJPEG(85)
}

async function getJson(url: string): Promise<unknown> {
  // MangaDex's API turns away browsers (the session says it is Chrome once a site was opened in it): the app names itself.
  const response = await session.fromPartition(PARTITION).fetch(url, { headers: { 'User-Agent': API_AGENT } })
  if (!response.ok) throw new Error(`O site respondeu ${response.status}.`)
  return response.json()
}

/**
 * Opens a page, waiting out a bot check. One that does not pass on its own (Cloudflare's box to tick)
 * shows the window, for the person to pass it; the site's cookie then lets the next ones through.
 */
async function load(win: BrowserWindow, url: string): Promise<void> {
  await open(win, url)
  let shown = false
  for (let waited = 0; await isChallenged(win); waited += 1_000) {
    if (!shown && waited >= CHALLENGE_SHOW_MS) {
      shown = true
      win.setTitle('Confirme a verificação do site')
      win.show()
    }
    if (waited > CHALLENGE_TIMEOUT_MS) throw new Error('O site pediu uma verificação que não foi concluída.')
    await sleep(1_000)
  }
  if (shown) {
    if (!win.isDestroyed()) win.hide()
    // The site's page loads after the check.
    await sleep(SETTLE_MS)
  }
  // Sent to the login page: in with the account in site-logins.env, when there is one.
  if (await signInIfAsked(win, url, (u) => open(win, u))) await sleep(SETTLE_MS)
}

async function attempt(site: CatalogSite, search: () => Promise<CatalogMatch[]>): Promise<SiteResult> {
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
