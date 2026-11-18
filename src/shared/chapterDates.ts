/**
 * When a chapter came out, from what a site writes beside its link: a date ("May 26, 2026",
 * "26/05/2026", "28 de outubro de 2026", "2026-05-26") or how long ago ("8 months, 1 week", "há 3
 * dias", "2 hours ago", "ontem").
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, janeiro: 0,
  feb: 1, february: 1, fev: 1, fevereiro: 1,
  mar: 2, march: 2, marco: 2, março: 2,
  apr: 3, april: 3, abr: 3, abril: 3,
  may: 4, mai: 4, maio: 4,
  jun: 5, june: 5, junho: 5,
  jul: 6, july: 6, julho: 6,
  aug: 7, august: 7, ago: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, set: 8, setembro: 8,
  oct: 9, october: 9, out: 9, outubro: 9,
  nov: 10, november: 10, novembro: 10,
  dec: 11, december: 11, dez: 11, dezembro: 11
}
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')

const UNITS: [RegExp, number][] = [
  [/^(?:seconds?|secs?|segundos?)$/, 1_000],
  [/^(?:minutes?|mins?|minutos?)$/, 60_000],
  [/^(?:hours?|hrs?|horas?)$/, 3_600_000],
  [/^(?:days?|dias?)$/, 86_400_000],
  [/^(?:weeks?|semanas?)$/, 7 * 86_400_000],
  [/^(?:months?|m[eê]s|meses)$/, 30 * 86_400_000],
  [/^(?:years?|anos?)$/, 365 * 86_400_000]
]
const UNIT = 'seconds?|secs?|segundos?|minutes?|mins?|minutos?|hours?|hrs?|horas?|days?|dias?|weeks?|semanas?|months?|m[eê]s|meses|years?|anos?'
const COUNT = '\\d+|an?|one|uma?'
const RELATIVE = new RegExp(`(?:^|[^\\p{L}\\d])(${COUNT})\\s+(${UNIT})(?![\\p{L}])`, 'giu')

/** Dates from a year ago at most a day ahead (time zones): what a release date can be. */
function plausible(t: number, now: number): boolean {
  return t <= now + 86_400_000 && t > Date.UTC(1990, 0, 1)
}

function day(year: number, month: number, date: number, now: number): number | null {
  if (month < 0 || month > 11 || date < 1 || date > 31) return null
  const t = new Date(year, month, date, 12).getTime()
  return plausible(t, now) ? t : null
}

/** "saiu hoje", "saiu há 3 dias", "saiu em 26 de mai. de 2026": when a chapter came out, said shortly. */
export function releaseLabel(at: number, now = Date.now()): string {
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return 'saiu hoje'
  if (days === 1) return 'saiu ontem'
  if (days < 7) return `saiu há ${days} dias`
  return `saiu em ${new Date(at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' })}`
}

function startOfDay(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** The release date in a site's text beside a chapter's link, in ms; null when it holds none. */
export function parseReleaseDate(text: string, now = Date.now()): number | null {
  const s = text.normalize('NFC').replace(/ /g, ' ').toLowerCase()

  // 2026-05-26, 2026-05-26T15:14:00Z
  const iso = /\b(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(z|[+-]\d{2}:?\d{2})?)?/.exec(s)
  if (iso) {
    const t = iso[4] ? Date.parse(iso[0].toUpperCase().replace(' ', 'T')) : day(+iso[1], +iso[2] - 1, +iso[3], now)
    if (t !== null && !Number.isNaN(t) && plausible(t, now)) return t
  }
  // May 26, 2026 · Sep. 3 2025
  const mdy = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`).exec(s)
  if (mdy) return day(+mdy[3], MONTHS[mdy[1]], +mdy[2], now)
  // 26 May 2026 · 28 de outubro de 2026 · 28 out. 2026
  const dmy = new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?(${MONTH})\\.?,?\\s+(?:de\\s+)?(\\d{4})`).exec(s)
  if (dmy) return day(+dmy[3], MONTHS[dmy[2]], +dmy[1], now)
  // 26/05/2026, 05/26/2026, 26.05.26: day first unless that cannot be (Brazilian sites write it so).
  const num = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(s)
  if (num) {
    const year = num[3].length === 2 ? 2000 + +num[3] : +num[3]
    const a = +num[1]
    const b = +num[2]
    return a > 12 || b <= 12 ? day(year, b - 1, a, now) : day(year, a - 1, b, now)
  }
  if (/\b(?:just now|agora mesmo|today|hoje)\b/.test(s)) return now
  if (/\b(?:yesterday|ontem)\b/.test(s)) return now - 86_400_000
  // "8 months, 1 week", "2 hours ago", "há 3 dias": every part counts. Without "ago" the time must end
  // the text, as sites put it after the chapter's name: "The 3 Days War" is a title.
  const parts = [...s.matchAll(RELATIVE)]
  if (!parts.length) return null
  const said = /\b(?:ago|atr[aá]s)\b|(?:^|\s)h[aá]\s/.test(s)
  const last = parts[parts.length - 1]
  if (!said && s.slice(last.index! + last[0].length).replace(/[\s,.;:)|]+/g, '') !== '') return null
  let ago = 0
  for (const m of parts) {
    const count = /^\d+$/.test(m[1]) ? +m[1] : 1
    const unit = UNITS.find(([re]) => re.test(m[2]))
    if (unit) ago += count * unit[1]
  }
  return ago > 0 ? now - ago : null
}
