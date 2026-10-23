import { normalizeName } from './works'

/**
 * The sites works are looked up on: MangaDex (its public API) and mgeko (its pages). They give a work
 * its other names, its cover, the page checked for new chapters, and chapters to translate in a row.
 * (comix asks that no third-party apps use it, and turns them away, so it is not one of them.)
 */
export type CatalogSite = 'mangadex' | 'mgeko'

export const CATALOG_SITES: Record<CatalogSite, string> = {
  mangadex: 'MangaDex',
  mgeko: 'mgeko'
}

/** A work found on one of the sites. */
export interface CatalogMatch {
  site: CatalogSite
  title: string
  /** The work's page there, the one that lists its chapters. */
  url: string
  cover: string | null
  /** Other names the site knows; the work page has them all, search results only some. */
  altNames: string[]
  /** The newest chapter listed, when the site says. */
  latest: number | null
  /** The cover as a data URL, for showing the results (the app's pages show no images from sites). */
  thumb?: string
}

/** What a site answered: its matches, or why it could not be searched. */
export interface CatalogResult {
  site: CatalogSite
  matches: CatalogMatch[]
  error?: string
}

/** A match whose title or other names include one of the work's names exactly (ignoring case and accents). */
export function isSameWork(names: string[], match: Pick<CatalogMatch, 'title' | 'altNames'>): boolean {
  const known = new Set(names.map(normalizeName).filter(Boolean))
  return [match.title, ...match.altNames].some((n) => known.has(normalizeName(n)))
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
