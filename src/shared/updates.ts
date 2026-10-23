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
}

/** What the library shows of a work: its newest chapter on any of its sites. */
export interface WorkUpdate {
  workId: string
  latest: number
  url: string
  site: string
  checkedAt: number
}

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
}

const CHAPTER_TEXT = /(?:\b(?:chapter|chap|ch|cap(?:[ií]tulo)?|ep(?:is[oó]dio|isode)?)\.?\s*[-#:]?\s*|#)(\d+(?:[.,]\d+)?)/i

/**
 * The highest chapter among a work page's links. Only links to the same site that carry the work's
 * name in their path count, so "popular this week" lists of other works around it are left out.
 */
export function latestChapter(source: string, links: PageLink[]): { chapter: number; url: string } | null {
  let page: URL
  try {
    page = new URL(source)
  } catch {
    return null
  }
  const slug = workSlug(page.pathname)
  let best: { chapter: number; url: string } | null = null
  for (const link of links) {
    let url: URL
    try {
      url = new URL(link.href, page)
    } catch {
      continue
    }
    if (stripWww(url.hostname) !== stripWww(page.hostname)) continue
    const path = decodeURIComponent(url.pathname).toLowerCase()
    if (slug ? !path.includes(slug) : !path.startsWith(page.pathname.toLowerCase())) continue
    const fromText = CHAPTER_TEXT.exec(link.text)
    const chapter = chapterInUrl(url.href) ?? (fromText ? parseFloat(fromText[1].replace(',', '.')) : null)
    // Years and ids that look like chapter numbers.
    if (chapter === null || chapter > 5000) continue
    if (!best || chapter > best.chapter) best = { chapter, url: url.href }
  }
  return best
}

/** "/series/solo-leveling-ragnarok-7f873ca6/" → "solo-leveling-ragnarok" (without the site's id). */
function workSlug(pathname: string): string | null {
  const segments = decodeURIComponent(pathname).toLowerCase().split('/').filter(Boolean)
  const slug = [...segments].reverse().find((s) => /[a-z].*[-_].*[a-z]/.test(s))
  return slug ? slug.replace(/[-_](?=[a-z]*\d)[a-z0-9]{4,}$/, '') : null
}

const stripWww = (host: string): string => host.replace(/^www\./, '')

/** Updates past the last chapter read of their work: the ones to show as new. */
export function unreadUpdates(updates: Record<string, WorkUpdate>, read: { workId: string; chapter: number; status: string }[]): WorkUpdate[] {
  return Object.values(updates).filter((u) => {
    const chapters = read.filter((r) => r.workId === u.workId && r.status === 'read').map((r) => r.chapter)
    return !chapters.length || u.latest > Math.max(...chapters)
  })
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
