import { parseReleaseDate } from './chapterDates'
import { chapterInUrl } from './works'

/**
 * New chapters: the PC opens each work's pages on its sites now and then and looks for the highest
 * chapter listed. A chapter beyond the last one read is new, and is announced once.
 */

/** How many sites a work is checked on. */
export const MAX_SOURCES = 3

/** The last check of one site page. */
export interface SourceCheck {
  checkedAt: number
  /** The highest chapter listed, and its link; null when none was found. */
  latest: number | null
  latestUrl: string | null
  /** Why the check failed ("needs verification" when the site asked for a bot check). */
  error?: string
  /** By chapter number, when each came out, where the site says (the first date seen stays). */
  dates?: Record<string, number>
  /** When the check first found `latest` (a newer chapter than the one before): for sites that give no dates. */
  latestSince?: number
}

/** What the library shows of a work: its newest chapter on any of its sites. */
export interface WorkUpdate {
  workId: string
  latest: number
  url: string
  site: string
  checkedAt: number
  /** When the newest chapter came out, where the site says. */
  date?: number
  /** When the app first saw it, for sites that give no date. */
  since?: number
}

/** A chapter counts as new for this long after it came out (or was first seen, without a date). */
export const NEW_FOR_MS = 7 * 24 * 60 * 60_000

export interface UpdatesStatus {
  /** By work id, works whose sites list a chapter. */
  updates: Record<string, WorkUpdate>
  /** By site page. */
  checks: Record<string, SourceCheck>
  lastRun: number | null
  running: boolean
  ntfyTopic: string | null
}

export interface PageLink {
  href: string
  text: string
  /** The text and date attributes of the link's row in the list, where sites write when it came out. */
  when?: string
}

/**
 * Runs in a page: its links (those `selector` picks), each with its row in the list (the closest
 * parent holding no other links) for the date beside it, in text or in attributes (datetime, tooltips).
 */
export function linksScript(selector = 'a[href]'): string {
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].map((a) => {
    let row = a
    for (let i = 0; i < 4 && row.parentElement; i++) {
      const up = row.parentElement
      if (up.querySelectorAll('a[href]').length > 3 || (up.innerText || '').length > 400) break
      row = up
    }
    const names = ['datetime', 'title', 'uk-tooltip', 'data-original-title', 'data-date', 'data-time']
    const attrs = [row, ...row.querySelectorAll('*')].flatMap((el) => names.map((n) => el.getAttribute(n)).filter(Boolean))
    return {
      href: a.href,
      text: (a.innerText || a.textContent || '').trim().slice(0, 120),
      when: ((row.innerText || row.textContent || '') + ' | ' + attrs.join(' | ')).replace(/\\s+/g, ' ').slice(0, 400)
    }
  })`
}

const CHAPTER_TEXT = /(?:\b(?:chapter|chap|ch|cap(?:[ií]tulo)?|ep(?:is[oó]dio|isode)?)\.?\s*[-#:]?\s*|#)(\d+(?:[.,]\d+)?)/i

export interface ChapterLink {
  chapter: number
  url: string
  /** When it came out, where the site says. */
  date?: number
}

/** By chapter number, the dates among chapter links. */
export function datesOf(chapters: ChapterLink[]): Record<string, number> {
  return Object.fromEntries(chapters.filter((c) => c.date).map((c) => [String(c.chapter), c.date!]))
}

/** A work's chapter dates from all its sites: the earliest each was seen out on. */
export function workDates(sources: string[] | undefined, checks: Record<string, SourceCheck>): Record<string, number> {
  const dates: Record<string, number> = {}
  for (const source of sources ?? []) {
    for (const [chapter, date] of Object.entries(checks[source]?.dates ?? {})) {
      if (!dates[chapter] || date < dates[chapter]) dates[chapter] = date
    }
  }
  return dates
}

/** The highest chapter among a work page's links (see chapterLinks). */
export function latestChapter(source: string, links: PageLink[]): ChapterLink | null {
  return chapterLinks(source, links).at(-1) ?? null
}

/**
 * The chapters among a work page's links, in order, one link each. Only links to the same site that
 * carry the work's name in their path count, so "popular this week" lists of other works around it
 * are left out; `onlyThisWork` says the links are all the work's (a list of its chapters alone).
 * Sites whose links are bare ids ("/obra/186" listing "/capitulo/580922") have none of that: there the
 * links to chapter pages that say "Capítulo 293" count.
 */
export function chapterLinks(source: string, links: PageLink[], onlyThisWork = false): ChapterLink[] {
  const named = chapterLinksOf(source, links, onlyThisWork)
  if (named.length || onlyThisWork) return named
  const toChapterPages = links.filter((l) => CHAPTER_PAGE.test(l.href) && CHAPTER_TEXT.test(l.text))
  return chapterLinksOf(source, toChapterPages, true)
}

/** "/capitulo/580922", "/chapter/123": a chapter's page named by the site's id for it. */
const CHAPTER_PAGE = /\/(capitulo|chapter|cap|ch|episode|episodio)\/\d+/i

function chapterLinksOf(source: string, links: PageLink[], onlyThisWork: boolean): ChapterLink[] {
  let page: URL
  try {
    page = new URL(source)
  } catch {
    return []
  }
  const slug = workSlug(page.pathname)
  const found = new Map<number, string>()
  const dates = new Map<number, number>()
  const now = Date.now()
  for (const link of links) {
    let url: URL
    try {
      url = new URL(link.href, page)
    } catch {
      continue
    }
    if (stripWww(url.hostname) !== stripWww(page.hostname)) continue
    const path = decodeURIComponent(url.pathname).toLowerCase()
    if (!onlyThisWork && (slug ? !path.includes(slug) : !path.startsWith(page.pathname.toLowerCase()))) continue
    // What the link says first: in "/capitulo/580922" the number is the site's id, not the chapter.
    const fromText = CHAPTER_TEXT.exec(link.text)
    const chapter = fromText ? parseFloat(fromText[1].replace(',', '.')) : chapterInUrl(url.href)
    // Years and ids that look like chapter numbers.
    if (chapter === null || chapter > 5000) continue
    // The date may sit by another of the chapter's links (its number, its title).
    const date = link.when ? parseReleaseDate(link.when, now) : null
    if (date && !dates.has(chapter)) dates.set(chapter, date)
    if (found.has(chapter)) continue
    // Sites list a chapter once per group that translated it; the first is the newest upload.
    found.set(chapter, url.href.replace(/#.*$/, ''))
  }
  return [...found]
    .map(([chapter, url]) => ({ chapter, url, ...(dates.has(chapter) && { date: dates.get(chapter) }) }))
    .sort((a, b) => a.chapter - b.chapter)
}

/**
 * The links of the chapters after `from` up to `latest`, from the latest one's link when its number
 * stands alone in it ("/name/chapter-100/" gives "/name/chapter-99/"); only the latest otherwise.
 */
export function chaptersUpTo(latestUrl: string, latest: number, from: number): ChapterLink[] {
  const match = [...latestUrl.matchAll(new RegExp(`(?<!\\d)${latest}(?!\\d)`, 'g'))].at(-1)
  if (!Number.isInteger(latest) || match?.index === undefined) return [{ chapter: latest, url: latestUrl }]
  const first = Math.max(Math.floor(from) + 1, latest - 20)
  return Array.from({ length: latest - first + 1 }, (_, i) => first + i).map((n) => ({
    chapter: n,
    url: `${latestUrl.slice(0, match.index)}${n}${latestUrl.slice(match.index! + match[0].length)}`
  }))
}

/**
 * Sites often list only the latest chapters on the work's page (and the first). When the links follow
 * one pattern ("/name/chapter-77/"), the whole chapters missing between the first and the last are
 * filled in with it; one the site does not have fails on its own when opened.
 */
export function fillChapterGaps(chapters: ChapterLink[]): ChapterLink[] {
  const pattern = (c: ChapterLink): string | null => {
    // The number on its own ("chapter-77"), not inside an id.
    const match = [...c.url.matchAll(new RegExp(`(?<!\\d)${c.chapter}(?!\\d)`, 'g'))].at(-1)
    return Number.isInteger(c.chapter) && match?.index !== undefined
      ? `${c.url.slice(0, match.index)}{n}${c.url.slice(match.index + match[0].length)}`
      : null
  }
  const patterns = chapters.map(pattern)
  const template = patterns.find((p) => p !== null)
  if (!template || patterns.filter((p) => p === template).length < 2) return chapters
  const have = new Set(chapters.map((c) => c.chapter))
  const whole = chapters.filter((c) => Number.isInteger(c.chapter)).map((c) => c.chapter)
  const filled = [...chapters]
  for (let n = Math.min(...whole); n <= Math.max(...whole); n++) {
    if (!have.has(n)) filled.push({ chapter: n, url: template.replace('{n}', String(n)) })
  }
  return filled.sort((a, b) => a.chapter - b.chapter)
}

/**
 * "/series/solo-leveling-ragnarok-7f873ca6/" → "solo-leveling-ragnarok", "/manga/overgeared-mg1/" → "overgeared":
 * without the site's id, which its chapter links may leave out.
 */
function workSlug(pathname: string): string | null {
  const segments = decodeURIComponent(pathname).toLowerCase().split('/').filter(Boolean)
  const slug = [...segments].reverse().find((s) => /[a-z].*[-_].*[a-z]/.test(s))
  return slug ? slug.replace(/[-_](?=[a-z]*\d)[a-z0-9]{2,}$/, '') : null
}

const stripWww = (host: string): string => host.replace(/^www\./, '')

/** Updates past the last chapter read of their work: the ones to show as new. */
export function unreadUpdates(updates: Record<string, WorkUpdate>, read: { workId: string; chapter: number; status: string }[]): WorkUpdate[] {
  return Object.values(updates).filter((u) => {
    const chapters = read.filter((r) => r.workId === u.workId && r.status === 'read').map((r) => r.chapter)
    return !chapters.length || u.latest > Math.max(...chapters)
  })
}

/**
 * Out in the last week (by the site's date, else when the app first saw it): news, counted and
 * announced. Older chapters not read yet stay in the history under it.
 */
export function isRecent(update: WorkUpdate, now = Date.now()): boolean {
  const out = update.date ?? update.since
  return !!out && now - out <= NEW_FOR_MS
}

/** When the chapter came out, as far as is known, for putting the history in order. */
export function outAt(update: WorkUpdate): number {
  return update.date ?? update.since ?? update.checkedAt
}

/** A chapter's link → the work's page on that site: "/manga/name/chapter-53/" → "/manga/name/". */
export function sourceFromChapter(url: string): string | null {
  try {
    const u = new URL(url)
    const segments = u.pathname.split('/').filter(Boolean)
    const i = segments.findIndex((s) => chapterInUrl(`${u.origin}/${s}/`) !== null || /^(chapter|capitulo|cap|ch)$/i.test(s))
    // The work's name is the nearest segment before the chapter that reads like one ("/novels/name/post/capitulo-395/").
    const name = segments.slice(0, Math.max(i, 0)).findLastIndex((s) => /[a-z].*[-_].*[a-z]/i.test(s))
    if (name < 0) return null
    return `${u.origin}/${segments.slice(0, name + 1).join('/')}/`
  } catch {
    return null
  }
}
