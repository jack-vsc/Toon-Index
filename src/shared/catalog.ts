import { normalizeName, sameName } from './works'

/**
 * The sites works are looked up on: MangaDex (its public API) and mgeko (its pages). They give a work
 * its other names, its cover, the page checked for new chapters, and chapters to translate in a row.
 * (comix asks that no third-party apps use it, and turns them away, so it is not one of them.)
 */
export type CatalogSite = 'mangadex' | 'mgeko' | 'mangakakalot' | 'mangalivre'

export const CATALOG_SITES: Record<CatalogSite, string> = {
  mangadex: 'MangaDex',
  mgeko: 'mgeko',
  mangakakalot: 'MangaKakalot',
  mangalivre: 'MangaLivre (português)'
}

/**
 * Where a search's results come from: a catalog site, or the person's own sites in Portuguese (those
 * the library's works are followed on), searched by the work's names in Portuguese too.
 */
export type ResultSite = CatalogSite | 'sites'

export const RESULT_SITES: Record<ResultSite, string> = { ...CATALOG_SITES, sites: 'Nos seus sites em português' }

/** A work found on one of the sites (`link`: its page on one of the person's own sites). */
export interface CatalogMatch {
  site: CatalogSite | 'link'
  title: string
  /** The work's page there, the one that lists its chapters. */
  url: string
  cover: string | null
  /** Other names the site knows; the work page has them all, search results only some. */
  altNames: string[]
  /** The newest chapter listed, when the site says. */
  latest: number | null
  /** Its names in Portuguese, when the site says (MangaDex): what the Portuguese sites call it. */
  ptNames?: string[]
  /** The cover as a data URL, for showing the results (the app's pages show no images from sites). */
  thumb?: string
}

/** What a site answered: its matches, or why it could not be searched. */
export interface CatalogResult {
  site: ResultSite
  matches: CatalogMatch[]
  error?: string
}

/** A match whose title or other names include one of the work's names exactly (ignoring case and accents). */
export function isSameWork(names: string[], match: Pick<CatalogMatch, 'title' | 'altNames'>): boolean {
  const known = new Set(names.map(normalizeName).filter(Boolean))
  return [match.title, ...match.altNames].some((n) => known.has(normalizeName(n)))
}

/**
 * A match with a name all but the same as one of the work's ("The Max Level Hero Has Returned" and
 * "The Max-Leveled Hero Has Returned!"), or one the work's name was cut short of: close enough for its
 * cover, not for taking its names and pages. A subtitle after it is another work ("Solo Leveling: Ragnarok").
 */
export function isLikelySameWork(names: string[], match: Pick<CatalogMatch, 'title' | 'altNames'>): boolean {
  const theirs = [match.title, ...match.altNames]
  return names.some((k) => theirs.some((n) => sameName(k, n) || (normalizeName(k).length >= 6 && dice(normalizeName(k), normalizeName(n)) >= 0.85)))
}

/** Dice coefficient on letter pairs. */
function dice(a: string, b: string): number {
  const pairs = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const pa = pairs(a)
  const pb = pairs(b)
  let common = 0
  for (const [p, n] of pa) common += Math.min(n, pb.get(p) ?? 0)
  return (2 * common) / Math.max(1, a.length - 1 + b.length - 1)
}

/**
 * Names worth keeping: in Latin letters (what the sites the person reads on use in their links), so
 * "템빨" and "Во всеоружии" are left out but "Item-ppal" and "Kekuatan Item" stay.
 */
export function readableNames(names: string[]): string[] {
  return names
    .map((n) => n.trim())
    .filter((n) => n.length > 1 && n.length <= 150 && /\p{Script=Latin}/u.test(n) && !/[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(n))
}
