/**
 * Which work (manga/manhwa title) a chapter belongs to. Chapters arrive named however the site or the
 * person named them: "[EN] [054] The Mythical Weapon Creation", "The Mythical Weapon Creation of the
 * Regressed Genius Player – Chapter 53", ".../manga/the-mythical-weapon-creation.../chapter-53/". Each
 * work keeps every name it has been seen under, so a chapter matches it by any of them.
 */

export interface Work {
  id: string
  /** Every name the work is known by; the first one is shown. */
  names: string[]
  createdAt: number
  /** A novel shares its name with the manga made from it, but is read apart from it. Absent for comics. */
  format?: 'novel'
  /** Up to three pages of the work on sites (its chapter list), checked for new chapters. */
  sources?: string[]
  /** When the work was looked up on the catalog sites (shared/catalog.ts), and the ones it was found on. */
  catalog?: { checkedAt: number; sites: CatalogSite[] }
}

import type { CatalogSite } from './catalog'

export type WorkFormat = 'comic' | 'novel'

export const formatOf = (work: Work): WorkFormat => work.format ?? 'comic'

/** Sites and paths of web novels: chapters there are text, not the manga of the same name. */
const NOVEL = /novel|wuxia|ranobe|royalroad|scribblehub|comrademao|webnovel|mtlnation|novelupdates/i

/** Whether a chapter's link is a web novel's. */
export function isNovelUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return NOVEL.test(u.hostname) || NOVEL.test(u.pathname)
  } catch {
    return false
  }
}

export interface ChapterName {
  /** The work's name as found, without tags, chapter number or site name. */
  work: string
  chapter: number | null
}

/** Names shorter than this (normalized) only match exactly: "Solo" must not match every "Solo …". */
const MIN_PREFIX = 12

const CHAPTER = /(?:\b(?:chapter|chap|ch|cap(?:[ií]tulo)?|ep(?:is[oó]dio|isode)?)\.?\s*[-#:]?\s*|#)(\d+(?:[.,]\d+)?)/i

/** Splits a chapter's title (file name, page title) and optionally its link into work name and number. */
export function parseChapterName(title: string, url?: string): ChapterName {
  let text = title.replace(/\.(pdf|cbz|zip)$/i, '')
  let chapter: number | null = null
  // "[054]" style numbers inside brackets; other bracket tags ([EN], [@Group]) are dropped.
  text = text.replace(/[[(]\s*(\d{1,4}(?:[.,]\d+)?)\s*[\])]/, (_m, n: string) => {
    chapter = parseFloat(n.replace(',', '.'))
    return ' '
  })
  text = text.replace(/\[[^\]]*\]|\([^)]*\)|@\S+/g, ' ')
  const found = CHAPTER.exec(text)
  if (found) {
    chapter ??= parseFloat(found[1].replace(',', '.'))
    // What follows the chapter number is the chapter's own title or the site's name.
    text = text.slice(0, found.index)
  }
  // "Read Name Chapter 5 Online", "Manga: Name Chapter 5" (the end went with the chapter number).
  text = text.replace(/^\s*(?:(?:read|ler|leia)\s+|(?:manga|manhwa|manhua|webtoon)\s*:\s*)/i, '')
  // "Name - Site" / "Name | Site": the site part goes when the rest still names something. When the
  // link says which part is the site ("MangaSite - Name" on mangasite.com), that part goes instead.
  let parts = text.split(/\s+[|–—-]\s+/).map((s) => s.trim()).filter(Boolean)
  const site = url ? siteName(url) : ''
  const named = site ? parts.filter((p) => !isSite(p, site)) : parts
  if (named.length < parts.length && named.length) parts = named
  else if (parts.length > 1) parts = parts.slice(0, -1)
  let work = parts.join(' - ').replace(/[\s\-–—:|,.·•]+$/, '').trim()
  if (url) {
    const fromUrl = parseUrl(url)
    chapter ??= fromUrl.chapter
    if (!work && fromUrl.work) work = fromUrl.work
  }
  return { work: work.replace(/\s+/g, ' '), chapter }
}

/** "www.manga-site.com" → "mangasite". */
function siteName(url: string): string {
  try {
    const labels = new URL(url).hostname.replace(/^www\./, '').split('.')
    return normalizeName(labels.length > 1 ? labels.slice(0, -1).join('') : labels[0])
  } catch {
    return ''
  }
}

function isSite(part: string, site: string): boolean {
  const name = normalizeName(part)
  return name.length >= 3 && (name.includes(site) || site.includes(name))
}

/** The chapter number in a link's path ("/chapter-53/"), or null. */
export function chapterInUrl(url: string): number | null {
  return parseUrl(url).chapter
}

/** "/manga/the-mythical-weapon/chapter-53/" → "the mythical weapon", 53. */
function parseUrl(url: string): ChapterName {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    // "chapter-53", or "chapter/53" split in two.
    const label = (i: number): string =>
      (/^(chapter|capitulo|cap|ch|episode|ep)$/i.test(segments[i]) && /^\d/.test(segments[i + 1] ?? '') ? `${segments[i]} ${segments[i + 1]}` : segments[i]).replace(/[-_]/g, ' ')
    const i = segments.findIndex((_s, j) => CHAPTER.test(label(j)))
    const chapterSeg = i >= 0 ? CHAPTER.exec(label(i)) : null
    // The work's segment comes before the chapter's, perhaps with others between ("/novels/name/post/capitulo-5").
    const named = (s: string) => /[a-z].*[-_].*[a-z]/i.test(s)
    const slug = i > 0 ? (segments.slice(0, i).reverse().find(named) ?? segments[i - 1]) : segments.find(named)
    // "solo-leveling-7f873ca6": the site's id for the work is not part of its name.
    const name = slug ? slug.replace(/[-_](?=[a-z]*\d)[a-z0-9]{4,}$/i, '').replace(/[-_]+/g, ' ') : ''
    return { work: name, chapter: chapterSeg ? parseFloat(chapterSeg[1]) : null }
  } catch {
    return { work: '', chapter: null }
  }
}

/** Lowercase letters and digits only, accents removed: "Gênio Regressado!" → "genioregressado". */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Same name, or one cut short of the other (file names are often truncated) — unless what the longer
 * one goes on with is a subtitle: "Solo Leveling: Ragnarok" and "Tower of God 2" are other works.
 */
export function sameName(a: string, b: string): boolean {
  const x = normalizeName(a)
  const y = normalizeName(b)
  if (!x || !y) return false
  if (x === y) return true
  const [short, long, longRaw] = x.length <= y.length ? [x, y, b] : [y, x, a]
  if (short.length < MIN_PREFIX || !long.startsWith(short)) return false
  return !/^\s*([:–—(]|-\s|\d|season\b|part\b|temporada\b|parte\b)/i.test(rest(longRaw, short.length))
}

/** The raw text of `name` after its first `count` normalized characters. */
function rest(name: string, count: number): string {
  let seen = 0
  for (let i = 0; i < name.length; i++) {
    if (seen === count) return name.slice(i)
    seen += normalizeName(name[i]).length
  }
  return ''
}

/**
 * The work of that format one of whose names matches; the longest matching name wins when several
 * works match.
 */
export function findWork(works: Work[], name: string, format: WorkFormat = 'comic'): Work | null {
  let best: Work | null = null
  let bestLength = 0
  for (const work of works) {
    if (formatOf(work) !== format) continue
    for (const known of work.names) {
      if (!sameName(known, name)) continue
      const length = Math.min(normalizeName(known).length, normalizeName(name).length)
      if (length > bestLength) (best = work), (bestLength = length)
    }
  }
  return best
}

/**
 * Adds a name the work was not known by yet. When it is a fuller form of the name shown, or the name
 * shown was cut mid-word, it becomes the one shown.
 */
export function withName(work: Work, name: string): Work {
  const clean = name.trim()
  if (!clean) return work
  const key = normalizeName(clean)
  if (work.names.some((n) => normalizeName(n) === key)) return work
  const names = [...work.names, clean]
  const shown = normalizeName(names[0])
  const related = key.startsWith(shown) || shown.startsWith(key)
  // A lowercase name taken from a link does not replace one written properly.
  const lowercase = (n: string) => n === n.toLowerCase()
  const better = cutShort(names[0])
    ? !cutShort(clean)
    : !cutShort(clean) && key.length > shown.length && (!lowercase(clean) || lowercase(names[0]))
  if (related && better) names.unshift(names.pop()!)
  return { ...work, names }
}

/** "The Mythical Weapon Creation o": a file name cut in the middle of a word (titles don't end in one lowercase letter). */
function cutShort(name: string): boolean {
  return /\s\p{Ll}$/u.test(name.trim())
}

/** "The mythical weapon creation" → "The Mythical Weapon Creation" (names taken from links are lowercase). */
export function displayName(name: string): string {
  return name === name.toLowerCase() ? name.replace(/(^|\s)(\p{L})/gu, (_m, s: string, c: string) => s + c.toUpperCase()) : name
}
