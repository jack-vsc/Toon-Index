import { useEffect, useState, type ReactNode } from 'react'
import { CATALOG_SITES, isSameWork, type CatalogMatch, type CatalogResult } from '../../../shared/catalog'
import type { ReadingRecord } from '../../../shared/reading'
import { chapterCount, isDownloaded, languageLabel, type LibraryEntry } from '../../../shared/types'
import { MAX_SOURCES, sourceFromChapter, unreadUpdates, type UpdatesStatus, type WorkUpdate } from '../../../shared/updates'
import { displayName, formatOf, normalizeName, SHELVES, shelfOf, type Shelf, type Work, type WorkFormat } from '../../../shared/works'
import { HistoryImport } from './HistoryImport'

/** A work with its translated chapters (in reading order) and readings. */
export interface WorkGroup {
  work: Work
  chapters: LibraryEntry[]
  records: ReadingRecord[]
}

export interface LibraryData {
  /** Works with something to show: a new chapter out first, then the one read most recently. */
  groups: WorkGroup[]
  /** By work id, a chapter out past the last one read. */
  fresh: Map<string, WorkUpdate>
  /** By work id, the cover found on the catalog sites. */
  covers: Record<string, string>
  /** By work id, the newest chapter out on its sites, for how far along the reading is. */
  latest: Map<string, number>
}

interface Actions {
  onOpen: (entry: LibraryEntry) => void
  onDownload: (entry: LibraryEntry) => void
  onDelete: (entry: LibraryEntry) => void
  /** Called after names, merges, moves or reading marks changed. */
  onWorksChanged: () => void
}

export function useLibrary(entries: LibraryEntry[], works: Work[], reading: ReadingRecord[], updates: UpdatesStatus | null): LibraryData {
  const [covers, setCovers] = useState<Record<string, string>>({})

  // Covers found on the catalog sites; they come as works are looked up there (on each check of the sites).
  useEffect(() => {
    window.api.works.covers().then(setCovers)
  }, [works, updates?.running])

  const fresh = new Map(unreadUpdates(updates?.updates ?? {}, reading).map((u) => [u.workId, u]))
  const groups = works
    .map((work) => ({
      work,
      chapters: entries.filter((e) => e.workId === work.id).sort(byChapter),
      records: reading.filter((r) => r.workId === work.id).sort((a, b) => a.chapter - b.chapter)
    }))
    .filter((g) => g.chapters.length > 0 || g.records.length > 0 || g.work.shelf || g.work.favorite)
    .sort((a, b) => Number(fresh.has(b.work.id)) - Number(fresh.has(a.work.id)) || lastActivity(b) - lastActivity(a))
  const latest = new Map(Object.values(updates?.updates ?? {}).map((u) => [u.workId, u.latest]))
  return { groups, fresh, covers, latest }
}

/** The work's own cover, or its latest translated chapter's. */
function coverOf(group: WorkGroup, covers: Record<string, string>): string | null {
  return covers[group.work.id] ?? [...group.chapters].sort((a, b) => b.createdAt - a.createdAt)[0]?.cover ?? null
}

/** The library chapter to go on with: the one left halfway, or the first after the last one read. */
export function nextInLibrary(group: WorkGroup): LibraryEntry | null {
  const read = group.records.filter((r) => r.status === 'read').map((r) => r.chapter)
  const upTo = read.length ? Math.max(...read) : -Infinity
  const latest = (chapter: number) => group.chapters.filter((e) => e.chapter === chapter).sort((a, b) => b.createdAt - a.createdAt)[0]
  const halfway = group.records.filter((r) => r.status === 'reading' && r.chapter > upTo).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (halfway && latest(halfway.chapter)) return latest(halfway.chapter)
  return group.chapters.filter((e) => e.chapter !== null && e.chapter > upTo).sort((a, b) => a.chapter! - b.chapter!)[0] ?? null
}

/** How far the reading is: the last chapter read, out of the newest one out when that is known. */
function progressOf(group: WorkGroup, latest: number | undefined): { upTo: number | null; share: number | null } {
  const read = group.records.filter((r) => r.status === 'read').map((r) => r.chapter)
  const upTo = read.length ? Math.max(...read) : null
  const newest = newestChapter(group, latest)
  return {
    upTo,
    share: upTo !== null && newest > 0 ? Math.min(1, upTo / newest) : null
  }
}

/** The newest chapter known: out on its sites, translated, or read (a site may be behind the reading). */
function newestChapter(group: WorkGroup, latest: number | undefined): number {
  return Math.max(latest ?? 0, ...group.chapters.map((c) => c.chapter ?? 0), ...group.records.map((r) => r.chapter))
}

/** "Cap. 45 · 45% lido", "Concluído · Cap. 222", "Não lido · 5 trad." under a cover. */
function metaLine(group: WorkGroup, latest: number | undefined): string {
  const { upTo, share } = progressOf(group, latest)
  const shelf = group.work.shelf && group.work.shelf !== 'reading' ? SHELVES[group.work.shelf] : null
  const parts: string[] = []
  if (shelf) parts.push(shelf)
  if (upTo !== null) parts.push(`Cap. ${upTo}`)
  else if (!shelf) parts.push(group.records.length ? 'Lendo' : 'Não lido')
  if (share !== null && share < 1 && group.work.shelf !== 'done') parts.push(`${Math.round(share * 100)}% lido`)
  if (group.work.format === 'novel') parts.push('Novel')
  if (group.chapters.length && upTo === null) parts.push(chapterCount(group.chapters, true).toLowerCase())
  return parts.join(' · ')
}

function Cover({ src, className }: { src: string | null; className: string }) {
  return <div className={className}>{src ? <img src={src} alt="" /> : <span>📚</span>}</div>
}

/**
 * The library as a wall of covers, like the scans' collections: the lists on the left with their
 * counts, then the covers of the one chosen, searched and sorted; a cover opens the work's page.
 */
export function LibraryView({
  data,
  updates,
  onPick,
  onWorksChanged
}: {
  data: LibraryData
  updates: UpdatesStatus | null
  onPick: (workId: string) => void
  onWorksChanged: () => void
}) {
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const [help, setHelp] = useState(false)
  const [filter, setFilter] = useState<LibraryFilter>(() => saved('library-filter', isFilter, 'all'))
  const [sort, setSort] = useState<LibrarySort>(() => saved('library-sort', (v): v is LibrarySort => v in SORTS, 'recent'))
  const [format, setFormat] = useState<WorkFormat | 'all'>('all')
  const query = normalizeName(search)
  const inFilter = (g: WorkGroup, f: LibraryFilter) =>
    f === 'all' ? true : f === 'favorite' ? !!g.work.favorite : shelfOf(g.work, g.records.length > 0) === f
  const listed = data.groups.filter((g) => inFilter(g, filter))
  const formats = new Set(listed.map((g) => formatOf(g.work)))
  const groups = listed
    .filter((g) => (format === 'all' || formatOf(g.work) === format) && (!query || g.work.names.some((n) => normalizeName(n).includes(query))))
    .sort(SORTS[sort].compare(data))
  const remember =
    <T extends string>(key: string, set: (v: T) => void) =>
    (value: T) => {
      set(value)
      try {
        localStorage.setItem(key, value)
      } catch {
        // Not kept: the library opens as it always does next time.
      }
    }
  const pickFilter = remember<LibraryFilter>('library-filter', setFilter)
  const pickSort = remember<LibrarySort>('library-sort', setSort)
  const navItem = ([f, label]: [LibraryFilter, string]) => (
    <button key={f} className={`library-nav-item ${filter === f ? 'active' : ''}`} onClick={() => pickFilter(f)}>
      <span>{label}</span>
      <span className="library-nav-count">{data.groups.filter((g) => inFilter(g, f)).length || ''}</span>
    </button>
  )
  const title = filter === 'all' ? 'Todas as obras' : filter === 'favorite' ? 'Favoritas' : SHELVES[filter]

  return (
    <div className="page library-page">
      <aside className="library-nav">
        <h1>Biblioteca</h1>
        {navItem(['all', 'Todas'])}
        {navItem(['favorite', 'Favoritas'])}
        <div className="library-nav-label">Status</div>
        {(Object.entries(SHELVES) as [Shelf, string][]).map(navItem)}
        <div className="library-nav-label">Mais</div>
        <button className="library-nav-item" onClick={() => setImporting(true)}>
          Importar histórico
        </button>
        <button className={`library-nav-item ${help ? 'active' : ''}`} onClick={() => setHelp(!help)}>
          Extensão do navegador
        </button>
        <CheckButton updates={updates} className="library-nav-item" />
      </aside>

      <div className="library-main">
        <div className="library-head">
          <h2>
            {title} <span className="library-count">{listed.length}</span>
          </h2>
          <input type="search" placeholder="Buscar por qualquer nome…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={sort} onChange={(e) => pickSort(e.target.value as LibrarySort)} title="Ordem">
            {(Object.entries(SORTS) as [LibrarySort, Sort][]).map(([key, s]) => (
              <option key={key} value={key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {formats.size > 1 && (
          <div className="format-tabs">
            {FORMAT_TABS.map(([f, label]) => (
              <button key={f} className={format === f ? 'active' : ''} onClick={() => setFormat(f)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {help && <ExtensionHelp onClose={() => setHelp(false)} />}
        {importing && <HistoryImport onClose={() => setImporting(false)} onImported={onWorksChanged} />}

        {data.groups.length === 0 && (
          <p className="hint center">Os capítulos que você traduzir ficam aqui, junto com onde você parou em cada obra lida no navegador.</p>
        )}
        {data.groups.length > 0 && groups.length === 0 && (
          <p className="hint center">
            {query ? 'Nenhuma obra com esse nome.' : 'Nenhuma obra nesta lista ainda: escolha a lista na página de cada obra.'}
          </p>
        )}

        <div className="poster-grid">
          {groups.map((g) => (
            <PosterCard key={g.work.id} group={g} data={data} onPick={() => onPick(g.work.id)} />
          ))}
        </div>
      </div>
    </div>
  )
}

type LibraryFilter = 'all' | 'favorite' | Shelf
type LibrarySort = 'recent' | 'updated' | 'progress' | 'title'

const FORMAT_TABS: [WorkFormat | 'all', string][] = [
  ['all', 'Tudo'],
  ['comic', 'Mangá'],
  ['novel', 'Novel']
]

interface Sort {
  label: string
  compare: (data: LibraryData) => (a: WorkGroup, b: WorkGroup) => number
}

const byFavorite = (a: WorkGroup, b: WorkGroup) => Number(!!b.work.favorite) - Number(!!a.work.favorite)

const SORTS: Record<LibrarySort, Sort> = {
  recent: {
    label: 'Lidas por último',
    compare: () => (a, b) => byFavorite(a, b) || lastActivity(b) - lastActivity(a)
  },
  updated: {
    label: 'Com capítulo novo',
    compare: (data) => (a, b) => Number(data.fresh.has(b.work.id)) - Number(data.fresh.has(a.work.id)) || lastActivity(b) - lastActivity(a)
  },
  progress: {
    label: 'Mais adiantadas',
    compare: (data) => (a, b) => (progressOf(b, data.latest.get(b.work.id)).share ?? -1) - (progressOf(a, data.latest.get(a.work.id)).share ?? -1)
  },
  title: {
    label: 'A–Z',
    compare: () => (a, b) => displayName(a.work.names[0]).localeCompare(displayName(b.work.names[0]), 'pt-BR')
  }
}

const isFilter = (v: string): v is LibraryFilter => v === 'all' || v === 'favorite' || v in SHELVES

function saved<T extends string>(key: string, valid: (v: string) => v is T, fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value && valid(value) ? value : fallback
  } catch {
    return fallback
  }
}

function CheckButton({ updates, className = 'secondary small' }: { updates: UpdatesStatus | null; className?: string }) {
  return (
    <button
      className={className}
      disabled={updates?.running}
      onClick={() => window.api.updates.check()}
      title={
        updates?.lastRun
          ? `Última checagem: ${new Date(updates.lastRun).toLocaleString('pt-BR')} (a cada 2 horas)`
          : 'Checa os sites de cada obra a cada 2 horas'
      }
    >
      {updates?.running ? 'Checando sites…' : 'Checar capítulos novos'}
    </button>
  )
}

/** A work's cover with its name under it, a heart when it is a favorite and how far it was read. */
function PosterCard({ group, data, onPick }: { group: WorkGroup; data: LibraryData; onPick: () => void }) {
  const cover = coverOf(group, data.covers)
  const update = data.fresh.get(group.work.id)
  const latest = data.latest.get(group.work.id)
  const { share } = progressOf(group, latest)
  return (
    <button className="poster-card" onClick={onPick} title={group.work.names.map(displayName).join('\n')}>
      <div className="poster">
        {cover ? <img src={cover} alt="" loading="lazy" /> : <span className="poster-empty">{displayName(group.work.names[0])}</span>}
        {update && <span className="poster-badge">Novo · {update.latest}</span>}
        {group.work.favorite && (
          <span className="poster-fav" title="Favorita">
            ♥
          </span>
        )}
      </div>
      {share !== null && (
        <div className="poster-progress">
          <span style={{ width: `${share * 100}%` }} />
        </div>
      )}
      <div className="poster-title">{displayName(group.work.names[0])}</div>
      <div className="poster-meta">{metaLine(group, latest)}</div>
    </button>
  )
}

/** How many new chapters the first page shows; the rest are on their own page. */
const HOME_UPDATES = 6

/** The works with a chapter out past the last one read: favorites first, then the ones checked last. */
export function freshWorks(data: LibraryData): { update: WorkUpdate; group: WorkGroup }[] {
  return [...data.fresh.values()]
    .map((u) => ({ update: u, group: data.groups.find((g) => g.work.id === u.workId) }))
    .filter((f): f is { update: WorkUpdate; group: WorkGroup } => !!f.group)
    .sort((a, b) => Number(!!b.group.work.favorite) - Number(!!a.group.work.favorite) || b.update.checkedAt - a.update.checkedAt)
}

/** A new chapter out: the work, how far behind the reading is, and where to read it. */
function UpdateRow({
  update,
  group,
  data,
  onPick,
  onTranslate
}: {
  update: WorkUpdate
  group: WorkGroup
  data: LibraryData
  onPick: () => void
  onTranslate?: () => void
}) {
  const { upTo } = progressOf(group, update.latest)
  const behind = upTo !== null ? Math.max(1, Math.floor(update.latest) - Math.floor(upTo)) : null
  return (
    <div className="update-row">
      <button className="update-cover" onClick={onPick}>
        <Cover src={coverOf(group, data.covers)} className="thumb" />
      </button>
      <div className="update-text">
        <button className="update-title" onClick={onPick}>
          {group.work.favorite ? '★ ' : ''}
          {displayName(group.work.names[0])}
        </button>
        <span>
          Capítulo {update.latest}
          {behind !== null && (
            <span className="muted">
              {' '}
              · {behind === 1 ? '1 capítulo' : `${behind} capítulos`} depois do {upTo}, o último lido
            </span>
          )}
        </span>
        <span className="mono muted">
          {update.site.toUpperCase()} · {timeAgo(update.checkedAt)}
        </span>
      </div>
      {onTranslate && (
        <button className="secondary small" onClick={onTranslate} title="Pôr os capítulos que faltam na fila">
          Traduzir
        </button>
      )}
      <button className="small" onClick={() => window.open(update.url)}>
        Ler
      </button>
    </div>
  )
}

/** Every work with a chapter out past the last one read: the app's notices. */
export function UpdatesView({
  data,
  updates,
  onPick,
  onTranslate
}: {
  data: LibraryData
  updates: UpdatesStatus | null
  onPick: (workId: string) => void
  /** The batch window, with the work's name in it. */
  onTranslate: (name: string) => void
}) {
  const fresh = freshWorks(data)
  return (
    <div className="page">
      <section className="home-section">
        <div className="section-head">
          <h2>
            Novidades <span className="library-count">{fresh.length}</span>
          </h2>
          <CheckButton updates={updates} />
        </div>
        <p className="hint">
          Obras com capítulo novo depois do último que você leu. Os sites de cada obra são checados a cada 2 horas
          {updates?.lastRun ? ` (última vez ${timeAgo(updates.lastRun)})` : ''}; a obra sai daqui quando você lê o capítulo.
        </p>
        {fresh.length === 0 ? (
          <p className="hint center">Nenhum capítulo novo por enquanto.</p>
        ) : (
          <div className="update-list">
            {fresh.map(({ update, group }) => (
              <UpdateRow
                key={update.workId}
                update={update}
                group={group}
                data={data}
                onPick={() => onPick(group.work.id)}
                onTranslate={() => onTranslate(displayName(group.work.names[0]))}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * The first page: the work being read now, new chapters out, translating, and the works read lately.
 */
export function HomeFeed({
  data,
  updates,
  onPick,
  onOpen,
  onAllUpdates,
  children
}: {
  data: LibraryData
  updates: UpdatesStatus | null
  onPick: (workId: string) => void
  onOpen: (entry: LibraryEntry) => void
  /** To the page with every work that has a new chapter. */
  onAllUpdates: () => void
  children: ReactNode
}) {
  const recent = [...data.groups].sort((a, b) => lastActivity(b) - lastActivity(a))
  const current = recent.find((g) => readingStatus(g.records)?.continueUrl) ?? recent[0]
  const fresh = freshWorks(data)

  return (
    <div className="page">
      {current && (
        <Hero
          group={current}
          cover={coverOf(current, data.covers)}
          update={data.fresh.get(current.work.id) ?? null}
          onPick={() => onPick(current.work.id)}
          onOpen={onOpen}
        />
      )}

      <section className="home-section">
        <div className="section-head">
          <h2>Capítulos novos</h2>
          {fresh.length > HOME_UPDATES && (
            <button className="secondary small" onClick={onAllUpdates}>
              Ver todos ({fresh.length})
            </button>
          )}
          <CheckButton updates={updates} />
        </div>
        {fresh.length === 0 ? (
          <p className="hint">
            Nenhum capítulo novo nas obras que você lê. Os sites de cada obra são checados a cada 2 horas
            {updates?.lastRun ? ` (última vez ${timeAgo(updates.lastRun)})` : ''}.
          </p>
        ) : (
          <div className="update-grid">
            {fresh.slice(0, HOME_UPDATES).map(({ update, group }) => (
              <UpdateRow key={update.workId} update={update} group={group} data={data} onPick={() => onPick(group.work.id)} />
            ))}
          </div>
        )}
      </section>

      <section className="home-section">
        <div className="section-head">
          <h2>Traduzir</h2>
        </div>
        {children}
      </section>

      {recent.length > 0 && (
        <section className="home-section">
          <div className="section-head">
            <h2>Lidos recentemente</h2>
          </div>
          <div className="poster-row">
            {recent.slice(0, 12).map((g) => (
              <PosterCard key={g.work.id} group={g} data={data} onPick={() => onPick(g.work.id)} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** The work being read, big, with where it was left and what came out since. */
function Hero({
  group,
  cover,
  update,
  onPick,
  onOpen
}: {
  group: WorkGroup
  cover: string | null
  update: WorkUpdate | null
  onPick: () => void
  onOpen: (entry: LibraryEntry) => void
}) {
  const status = readingStatus(group.records)
  const inApp = nextInLibrary(group)
  return (
    <section className="hero">
      {cover && <div className="hero-bg" style={{ backgroundImage: `url(${cover})` }} />}
      <button className="hero-cover" onClick={onPick}>
        <Cover src={cover} className="poster" />
      </button>
      <div className="hero-text">
        <span className="mono accent-label">CONTINUAR LENDO</span>
        <h2 onClick={onPick}>{displayName(group.work.names[0])}</h2>
        <div className="tags">
          <span className="tag">{group.work.format === 'novel' ? 'NOVEL' : 'MANGÁ'}</span>
          {status && siteOf(status.continueUrl) && <span className="tag">{siteOf(status.continueUrl).toUpperCase()}</span>}
          {group.chapters.length > 0 && <span className="tag">{chapterCount(group.chapters)}</span>}
        </div>
        {status && <p className="hero-status">{status.text}</p>}
        <div className="row">
          <ContinueButtons inApp={inApp} continueUrl={status?.continueUrl} onOpen={onOpen} />
          {update && (
            <button className="secondary" onClick={() => window.open(update.url)}>
              Ler o cap. {update.latest} ({update.site})
            </button>
          )}
          <button className="secondary" onClick={onPick}>
            Ver obra
          </button>
        </div>
      </div>
    </section>
  )
}

/** A work's page: its cover and names, where it was left, every chapter read or translated, and editing it. */
export function WorkPage({
  group,
  data,
  updates,
  others,
  onBack,
  onOpen,
  onDownload,
  onDelete,
  onWorksChanged
}: {
  group: WorkGroup
  data: LibraryData
  updates: UpdatesStatus | null
  others: Work[]
  onBack: () => void
} & Actions) {
  const { work, chapters, records } = group
  const [editing, setEditing] = useState(false)
  const cover = coverOf(group, data.covers)
  const update = data.fresh.get(work.id) ?? null
  const status = readingStatus(records)
  const aliases = work.names.slice(1)
  const rows = chapterRows(records, chapters)
  const inApp = nextInLibrary(group)
  const setShelf = async (patch: { shelf?: Shelf | null; favorite?: boolean }) => {
    await window.api.works.setShelf(work.id, patch)
    onWorksChanged()
  }

  const latest = data.latest.get(work.id)
  const { upTo, share } = progressOf(group, latest)
  const newest = newestChapter(group, latest) || null
  const [chapterQuery, setChapterQuery] = useState('')
  const [oldestFirst, setOldestFirst] = useState(false)
  const shownRows = rows.filter((r) => !chapterQuery.trim() || String(r.chapter).startsWith(chapterQuery.trim().replace(',', '.')))
  if (oldestFirst) shownRows.reverse()
  const shelf = shelfOf(work, records.length > 0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [fullSynopsis, setFullSynopsis] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      await window.api.works.refresh(work.id)
      onWorksChanged()
    } catch (err) {
      setRefreshError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="page work-page">
      <nav className="crumbs">
        <button className="link" onClick={onBack}>
          ← Biblioteca
        </button>
        <span>/</span>
        <span className="crumbs-now">{displayName(work.names[0])}</span>
      </nav>
      <section className="work-hero">
        {cover && <div className="hero-bg" style={{ backgroundImage: `url(${cover})` }} />}
        <Cover src={cover} className="poster work-poster" />
        <div className="hero-text">
          <div className="tags">
            <span className="tag">{work.format === 'novel' ? 'Novel' : 'Mangá'}</span>
            {shelf && <span className="tag tag-status">{SHELVES[shelf]}</span>}
            {(work.catalog?.sites ?? []).map((s) => (
              <span key={s} className="tag">
                {CATALOG_SITES[s] ?? s}
              </span>
            ))}
          </div>
          <h1>{displayName(work.names[0])}</h1>
          {aliases.length > 0 && <div className="work-aliases">{aliases.map(displayName).join(' · ')}</div>}
          <div className="work-stats">
            {newest !== null && (
              <span>
                <strong>{newest}</strong> capítulos
              </span>
            )}
            {chapters.length > 0 && (
              <span>
                <strong>{chapters.length}</strong> neste PC
              </span>
            )}
            {status && <span>{status.text}</span>}
          </div>
          <div className="row work-actions">
            <ContinueButtons inApp={inApp} continueUrl={status?.continueUrl} onOpen={onOpen} />
            {update && (
              <button className="secondary" onClick={() => window.open(update.url)} title={`Saiu no ${update.site}`}>
                Último · Cap. {update.latest}
              </button>
            )}
            <button className={`secondary fav-button ${work.favorite ? 'on' : ''}`} onClick={() => setShelf({ favorite: !work.favorite })}>
              {work.favorite ? '♥ Favorita' : '♡ Favoritar'}
            </button>
            <select
              className="pill-select"
              value={work.shelf ?? ''}
              title="A lista de leitura da obra"
              onChange={(e) => setShelf({ shelf: (e.target.value || null) as Shelf | null })}
            >
              <option value="">{records.length ? 'Lendo (automático)' : 'Em nenhuma lista'}</option>
              {(Object.entries(SHELVES) as [Shelf, string][]).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={() => setEditing(!editing)}>
              {editing ? 'Fechar edição' : 'Editar obra'}
            </button>
            <button
              className="secondary"
              onClick={refresh}
              disabled={refreshing}
              title="Capa, nome, sinopse, gêneros e situação do MangaDex, ou da página da obra no site dos capítulos"
            >
              {refreshing ? 'Atualizando…' : '↻ Atualizar dados'}
            </button>
          </div>
          {refreshError && <p className="hint error-text">{refreshError}</p>}
          {work.info?.synopsis && (
            <p className={`work-synopsis ${fullSynopsis ? 'full' : ''}`} onClick={() => setFullSynopsis(!fullSynopsis)} title={fullSynopsis ? '' : 'Ver tudo'}>
              {work.info.synopsis}
            </p>
          )}
          {!!work.info?.tags?.length && (
            <div className="tags work-genres">
              {work.info.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
          )}
          {share !== null && newest !== null && (
            <div className="work-progress">
              <div className="poster-progress">
                <span style={{ width: `${share * 100}%` }} />
              </div>
              <span>
                {upTo} de {newest} lidos
              </span>
            </div>
          )}
        </div>
      </section>

      {editing && (
        <WorkEditor
          work={work}
          others={others}
          records={records}
          checks={updates?.checks ?? {}}
          onDone={() => (setEditing(false), onWorksChanged())}
        />
      )}

      <div className="work-columns">
        <section className="chapter-panel">
          <div className="chapter-panel-head">
            <h2>
              Capítulos <span className="library-count">{rows.length}</span>
            </h2>
            <input type="search" inputMode="decimal" placeholder="Nº do capítulo" value={chapterQuery} onChange={(e) => setChapterQuery(e.target.value)} />
            <button className="secondary small" onClick={() => setOldestFirst(!oldestFirst)}>
              {oldestFirst ? '↑ Antigos' : '↓ Recentes'}
            </button>
          </div>
          {rows.length === 0 && <p className="hint">Nenhum capítulo lido ou traduzido ainda.</p>}
          <div className="chapter-rows">
            {shownRows.map(({ chapter, record, entry, versions }) => (
              <div key={chapter} className={`chapter-row ${record?.status === 'read' ? 'read' : ''}`}>
                <span className="chapter-num">{chapter}</span>
                <span className="chapter-text">
                  <span className="chapter-title">
                    Capítulo {chapter}
                    {record?.status === 'read' && <span className="badge ok">lido</span>}
                    {record?.status === 'reading' && (
                      <span className="badge">{record.progress !== null ? `${Math.round(record.progress * 100)}%` : 'lendo'}</span>
                    )}
                    {entry && versions.length === 1 && <span className="badge">{isDownloaded(entry) ? 'baixado' : 'traduzido'}</span>}
                    {versions.length > 1 && <span className="badge">{versions.length} versões</span>}
                  </span>
                  <span className="chapter-where">
                    {record
                      ? `${siteOf(record.url) || sourceLabel(record.source)} · ${timeAgo(record.updatedAt)}`
                      : entry
                        ? `${siteOf(entry.source ?? '') || 'arquivo'} · ${timeAgo(entry.createdAt)}`
                        : ''}
                  </span>
                  {versions.length > 1 && (
                    <span className="chapter-versions">
                      {versions.map((v) => (
                        <span key={v.id} className="chapter-version">
                          <button className="link" onClick={() => onOpen(v)} title={`Ler esta versão (${timeAgo(v.createdAt)})`}>
                            {versionLabel(v)}
                          </button>
                          <button
                            className="link danger"
                            title="Apagar esta versão"
                            onClick={() => {
                              if (confirm(`Apagar a versão de ${versionLabel(v)} do capítulo ${chapter}?`)) onDelete(v)
                            }}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="chapter-actions">
                  {entry && (
                    <button className="small" onClick={() => onOpen(entry)}>
                      Ler
                    </button>
                  )}
                  {record?.url && (
                    <button className="secondary small" onClick={() => window.open(record.url)}>
                      Site ↗
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>

        <aside className="info-card">
          <h3>Informações</h3>
          <dl>
            <dt>Formato</dt>
            <dd>{work.format === 'novel' ? 'Novel' : 'Mangá'}</dd>
            <dt>Lista</dt>
            <dd>{shelf ? SHELVES[shelf] : 'Nenhuma'}</dd>
            {work.info?.status && (
              <>
                <dt>Situação</dt>
                <dd>{work.info.status}</dd>
              </>
            )}
            {work.info?.year && (
              <>
                <dt>Ano</dt>
                <dd>{work.info.year}</dd>
              </>
            )}
            {work.info && (
              <>
                <dt>Dados de</dt>
                <dd>
                  <a href={work.info.from} target="_blank" rel="noreferrer">
                    {siteOf(work.info.from)} ↗
                  </a>{' '}
                  · {timeAgo(work.info.updatedAt)}
                </dd>
              </>
            )}
            {newest !== null && (
              <>
                <dt>Capítulos</dt>
                <dd>{newest}</dd>
              </>
            )}
            <dt>Capítulo novo</dt>
            <dd>
              <select
                className="pill-select"
                value={work.auto ?? ''}
                title={
                  work.sources?.length
                    ? 'O que fazer quando sair um capítulo novo num dos sites da obra (checados a cada 2 horas)'
                    : 'Adicione um site da obra em "Editar obra" para os capítulos novos serem achados'
                }
                onChange={async (e) => {
                  await window.api.works.setAuto(work.id, (e.target.value || null) as 'translate' | 'download' | null)
                  onWorksChanged()
                }}
              >
                <option value="">Só avisar</option>
                <option value="translate">Traduzir sozinho</option>
                <option value="download">Baixar sozinho (já em PT)</option>
              </select>
            </dd>
          </dl>
          {(work.sources ?? []).length > 0 && (
            <>
              <h4>Sites</h4>
              <div className="tags">
                {(work.sources ?? []).map((s) => (
                  <a key={s} className="tag link-tag" href={s} target="_blank" rel="noreferrer">
                    {siteOf(s)} ↗
                  </a>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>

      {chapters.length > 0 && (
        <section className="home-section">
          <div className="section-head">
            <h2>{chapters.every(isDownloaded) ? 'Baixados neste PC' : chapters.some(isDownloaded) ? 'Neste PC' : 'Traduzidos neste PC'}</h2>
            <span className="mono muted">{chapterRange(chapters).replace(/^ · /, '').toUpperCase()}</span>
          </div>
          <TranslatedGrid
            chapters={chapters}
            records={records}
            others={others}
            onOpen={onOpen}
            onDownload={onDownload}
            onDelete={onDelete}
            onWorksChanged={onWorksChanged}
          />
        </section>
      )}
    </div>
  )
}

interface ChapterRow {
  chapter: number
  record?: ReadingRecord
  /** The newest of `versions`, the one "Ler" opens. */
  entry?: LibraryEntry
  /** The chapter as saved from each site, newest first. */
  versions: LibraryEntry[]
}

/** Every chapter read or translated, newest first, the reading and the translations of each side by side. */
function chapterRows(records: ReadingRecord[], chapters: LibraryEntry[]): ChapterRow[] {
  const rows = new Map<number, ChapterRow>()
  for (const r of records) rows.set(r.chapter, { chapter: r.chapter, record: r, versions: [] })
  for (const e of [...chapters].sort((a, b) => b.createdAt - a.createdAt)) {
    if (e.chapter === null) continue
    const row = rows.get(e.chapter) ?? { chapter: e.chapter, versions: [] }
    row.versions.push(e)
    row.entry = row.versions[0]
    rows.set(e.chapter, row)
  }
  return [...rows.values()].sort((a, b) => b.chapter - a.chapter)
}

/** Where a saved chapter came from, to tell its versions apart. */
function versionLabel(entry: LibraryEntry): string {
  const site = siteOf(entry.source ?? '') || 'arquivo'
  return `${site} · ${isDownloaded(entry) ? 'baixado' : 'traduzido'}`
}

function TranslatedGrid({
  chapters,
  records,
  others,
  onOpen,
  onDownload,
  onDelete,
  onWorksChanged
}: {
  chapters: LibraryEntry[]
  records: ReadingRecord[]
  others: Work[]
} & Actions) {
  const readChapters = new Set(records.filter((r) => r.status === 'read').map((r) => r.chapter))
  return (
    <div className="library-grid">
      {chapters.map((entry) => (
        <div key={entry.id} className="library-card">
          <button className="library-cover" onClick={() => onOpen(entry)} title="Ler">
            {entry.cover ? <img src={entry.cover} alt={entry.title} /> : <span>📖</span>}
          </button>
          <div className="library-info">
            <strong title={entry.title}>
              {entry.chapter !== null ? `Capítulo ${entry.chapter}` : entry.title}
              {entry.chapter !== null && readChapters.has(entry.chapter) && <span className="read-mark"> ✓ lido</span>}
            </strong>
            <span>
              {isDownloaded(entry)
                ? `${languageLabel(entry.targetLanguage)} · baixado`
                : `${languageLabel(entry.sourceLanguage)} → ${languageLabel(entry.targetLanguage)}`}
              {entry.source && ` · ${siteOf(entry.source)}`}
            </span>
            <span>
              {entry.translatedPages === entry.pageCount
                ? `${entry.pageCount} páginas`
                : `${entry.translatedPages} de ${entry.pageCount} páginas traduzidas`}{' '}
              · {new Date(entry.createdAt).toLocaleDateString('pt-BR')}
            </span>
          </div>
          <div className="library-actions">
            <button onClick={() => onOpen(entry)}>Ler</button>
            <button className="secondary" onClick={() => onDownload(entry)} title="Baixar PDF">
              ⬇
            </button>
            <button
              className="secondary"
              title="Excluir"
              onClick={() => {
                if (confirm(`Excluir "${entry.title}" da biblioteca?`)) onDelete(entry)
              }}
            >
              🗑
            </button>
          </div>
          <select
            className="move-select"
            value=""
            title="Este capítulo é de outra obra?"
            onChange={async (e) => {
              const value = e.target.value
              if (!value) return
              await window.api.works.move(entry.id, value === '__new' ? { newName: '' } : { workId: value })
              onWorksChanged()
            }}
          >
            <option value="">Mover para outra obra…</option>
            {others.map((w) => (
              <option key={w.id} value={w.id}>
                {displayName(w.names[0])}
              </option>
            ))}
            <option value="__new">Nova obra (com o nome do arquivo)</option>
          </select>
        </div>
      ))}
    </div>
  )
}

function lastActivity(g: { chapters: LibraryEntry[]; records: ReadingRecord[] }): number {
  return Math.max(0, ...g.chapters.map((c) => c.createdAt), ...g.records.map((r) => r.updatedAt))
}

export function ExtensionHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="work-editor">
      <p>
        Com a extensão, o app marca sozinho os capítulos que você lê em qualquer site: <strong>lido</strong> quando você chega ao fim das páginas (ou
        abre o capítulo seguinte), <strong>em andamento</strong> com a posição quando para no meio. Com o app fechado, a extensão guarda as leituras e
        envia quando ele abrir.
      </p>
      <ol className="steps">
        <li>
          Abra <code>chrome://extensions</code> (Brave: <code>brave://extensions</code>, Opera: <code>opera://extensions</code>).
        </li>
        <li>Ligue o "Modo do desenvolvedor".</li>
        <li>
          Clique em "Carregar sem compactação" e escolha a pasta <code>extension</code> que vai abrir agora.
        </li>
      </ol>
      <div className="row">
        <button onClick={() => window.api.reading.openExtension()}>Abrir a pasta da extensão</button>
        <button className="secondary" onClick={onClose}>
          Fechar
        </button>
      </div>
    </div>
  )
}

/** Goes on reading: in the app when the chapter is in the library (offline too), else on the site. */
function ContinueButtons({
  inApp,
  continueUrl,
  onOpen
}: {
  inApp: LibraryEntry | null
  continueUrl?: string
  onOpen: (entry: LibraryEntry) => void
}) {
  return (
    <>
      {inApp && (
        <button onClick={() => onOpen(inApp)} title="Abre o capítulo da biblioteca, de onde você parou">
          {continueUrl ? 'Continuar' : 'Começar'}: cap. {inApp.chapter}
        </button>
      )}
      {continueUrl && (
        <button className={inApp ? 'secondary' : ''} onClick={() => window.open(continueUrl)}>
          {inApp ? 'No site ↗' : 'Continuar'}
        </button>
      )}
    </>
  )
}

/** "Lido até o cap. 53 · parou no cap. 54 (40%) · site.com · há 3 dias", and the page to go back to. */
function readingStatus(records: ReadingRecord[]): { text: string; continueUrl: string } | null {
  if (!records.length) return null
  const read = records.filter((r) => r.status === 'read').map((r) => r.chapter)
  const upTo = read.length ? Math.max(...read) : null
  const current = records.filter((r) => r.status === 'reading' && (upTo === null || r.chapter > upTo)).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const last = [...records].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const parts: string[] = []
  if (upTo !== null) parts.push(`Lido até o cap. ${upTo}`)
  if (current) {
    const where = current.progress !== null ? ` (${Math.round(current.progress * 100)}%)` : ''
    parts.push(`${upTo !== null ? 'parou no' : 'Parou no'} cap. ${current.chapter}${where}`)
  }
  const shown = current ?? last
  const site = siteOf(shown.url)
  if (site) parts.push(site)
  parts.push(timeAgo(shown.updatedAt))
  const withUrl = current?.url ? current : [...records].filter((r) => r.url).sort((a, b) => b.chapter - a.chapter)[0]
  return { text: parts.join(' · '), continueUrl: withUrl?.url ?? '' }
}

function siteOf(url: string): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

function sourceLabel(source: ReadingRecord['source']): string {
  return {
    browser: 'navegador',
    history: 'histórico',
    app: 'lido no app',
    manual: 'marcado à mão'
  }[source]
}

function timeAgo(at: number): string {
  const minutes = (Date.now() - at) / 60000
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
  if (minutes < 60) return rtf.format(-Math.round(minutes), 'minute')
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), 'hour')
  if (minutes < 60 * 24 * 30) return rtf.format(-Math.round(minutes / 60 / 24), 'day')
  if (minutes < 60 * 24 * 365) return rtf.format(-Math.round(minutes / 60 / 24 / 30), 'month')
  return rtf.format(-Math.round(minutes / 60 / 24 / 365), 'year')
}

/**
 * Edits the names a work is recognized by, merges another work (same title in another language/site)
 * into it, and marks chapters read somewhere the app could not see.
 */
function WorkEditor({
  work,
  others,
  records,
  checks,
  onDone
}: {
  work: Work
  others: Work[]
  records: ReadingRecord[]
  checks: UpdatesStatus['checks']
  onDone: () => void
}) {
  const hasReading = records.length > 0
  const [text, setText] = useState(work.names.join('\n'))
  const [sources, setSources] = useState<string[]>(work.sources ?? [])
  // The work's page on each site it was read on, from the chapters' links.
  const suggested = [...new Set(records.map((r) => sourceFromChapter(r.url)).filter((s): s is string => !!s))].filter((s) => !sources.includes(s))
  const [mergeId, setMergeId] = useState('')
  const [readUpTo, setReadUpTo] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function save() {
    try {
      await window.api.works.setNames(
        work.id,
        text.split('\n').map((s) => s.trim())
      )
      onDone()
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  async function merge() {
    const other = others.find((w) => w.id === mergeId)
    if (!other) return
    if (!confirm(`Juntar "${displayName(other.names[0])}" com esta obra? Os capítulos e os nomes dela passam para esta.`)) return
    await window.api.works.merge(work.id, other.id)
    onDone()
  }

  async function saveSources(next: string[]) {
    setError(null)
    try {
      await window.api.updates.setSources(work.id, next)
      setSources(next)
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  async function markRead() {
    const chapter = parseFloat(readUpTo.replace(',', '.'))
    if (!Number.isFinite(chapter)) return
    await window.api.reading.mark(work.id, chapter)
    onDone()
  }

  async function forget() {
    if (!confirm(`Apagar onde você parou em "${displayName(work.names[0])}"? Os capítulos traduzidos continuam na biblioteca.`)) return
    await window.api.reading.forget(work.id, null)
    onDone()
  }

  return (
    <div className="work-editor">
      <label className="field-label">Nomes da obra, um por linha (o primeiro é o principal)</label>
      <textarea rows={Math.min(8, Math.max(3, work.names.length + 1))} value={text} onChange={(e) => setText(e.target.value)} />
      <p className="hint">
        Capítulos novos com qualquer um desses nomes, ou com o começo deles (nomes cortados), entram nesta obra, seja no app ou lidos no navegador.
        Adicione os nomes usados em outros sites e idiomas.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button onClick={save}>Salvar nomes</button>
      </div>

      <CatalogSearch work={work} others={others} onLinked={onDone} />

      <label className="field-label" style={{ marginTop: 14 }}>
        Sites para avisar de capítulo novo (até {MAX_SOURCES}): a página da obra, a que lista os capítulos
      </label>
      {sources.map((source, i) => {
        const check = checks[source]
        return (
          <div key={i} className="row source-row">
            <input
              type="url"
              value={source}
              onChange={(e) => setSources(sources.map((s, j) => (j === i ? e.target.value : s)))}
              onBlur={() => saveSources(sources)}
            />
            <button className="secondary small" onClick={() => saveSources(sources.filter((_s, j) => j !== i))}>
              Tirar
            </button>
            {check && (
              <span className={check.error ? 'error source-check' : 'hint source-check'} title={check.error}>
                {check.error ? 'falhou' : `cap. ${check.latest}`} · {new Date(check.checkedAt).toLocaleString('pt-BR')}
              </span>
            )}
          </div>
        )
      })}
      {sources.length < MAX_SOURCES && (
        <div className="row">
          <button className="secondary small" onClick={() => setSources([...sources, ''])}>
            Adicionar site
          </button>
          {suggested.slice(0, MAX_SOURCES - sources.length).map((s) => (
            <button key={s} className="secondary small" title={s} onClick={() => saveSources([...sources, s])}>
              + {new URL(s).hostname.replace(/^www\./, '')}
            </button>
          ))}
        </div>
      )}

      <label className="field-label" style={{ marginTop: 14 }}>
        Leu em outro lugar (no celular, por exemplo)?
      </label>
      <div className="row">
        <input
          type="text"
          inputMode="decimal"
          placeholder="Capítulo"
          value={readUpTo}
          onChange={(e) => setReadUpTo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && markRead()}
          style={{ width: 110 }}
        />
        <button className="secondary" onClick={markRead} disabled={!readUpTo.trim()}>
          Marcar como lido até ele
        </button>
        {hasReading && (
          <button className="secondary" onClick={forget}>
            Apagar onde parei
          </button>
        )}
      </div>

      {others.length > 0 && (
        <>
          <label className="field-label" style={{ marginTop: 14 }}>
            É a mesma obra com outro nome?
          </label>
          <div className="row">
            <select value={mergeId} onChange={(e) => setMergeId(e.target.value)}>
              <option value="">Escolha a obra para juntar com esta…</option>
              {others.map((w) => (
                <option key={w.id} value={w.id}>
                  {displayName(w.names[0])}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={merge} disabled={!mergeId}>
              Juntar
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function byChapter(a: LibraryEntry, b: LibraryEntry): number {
  if (a.chapter !== null && b.chapter !== null) return a.chapter - b.chapter || a.createdAt - b.createdAt
  if (a.chapter !== null) return -1
  if (b.chapter !== null) return 1
  return a.createdAt - b.createdAt
}

function chapterRange(chapters: LibraryEntry[]): string {
  const numbers = chapters.map((c) => c.chapter).filter((n): n is number => n !== null)
  if (!numbers.length) return ''
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  return min === max ? ` · cap. ${min}` : ` · cap. ${min} a ${max}`
}

/**
 * Looks the work up on MangaDex, mgeko and comix; the ones chosen give it their other names, their
 * page to check for new chapters and a cover. Results with one of its names exactly come checked.
 */
function CatalogSearch({ work, others, onLinked }: { work: Work; others: Work[]; onLinked: () => void }) {
  const [query, setQuery] = useState(work.names[0])
  const [results, setResults] = useState<CatalogResult[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'search' | 'link' | null>(null)
  const linked = work.catalog?.sites ?? []

  async function search() {
    setBusy('search')
    try {
      const found = await window.api.works.search(query)
      setResults(found)
      setChosen(new Set(found.flatMap((r) => r.matches.find((m) => isSameWork(work.names, m))?.url ?? [])))
    } finally {
      setBusy(null)
    }
  }

  async function link() {
    const matches = (results ?? []).flatMap((r) => r.matches).filter((m) => chosen.has(m.url))
    setBusy('link')
    try {
      await window.api.works.link(work.id, matches)
      onLinked()
    } finally {
      setBusy(null)
    }
  }

  function toggle(match: CatalogMatch) {
    const next = new Set([...chosen].filter((url) => !results?.find((r) => r.site === match.site)?.matches.some((m) => m.url === url)))
    if (!chosen.has(match.url)) next.add(match.url)
    setChosen(next)
  }

  return (
    <>
      <label className="field-label" style={{ marginTop: 14 }}>
        Buscar nos sites ({Object.values(CATALOG_SITES).join(', ')}): outros nomes, capa e a página para avisar de capítulo novo
      </label>
      {linked.length > 0 && <p className="hint">Já encontrada no {linked.map((s) => CATALOG_SITES[s]).join(', ')}.</p>}
      <div className="row">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <button className="secondary" onClick={search} disabled={!!busy || !query.trim()}>
          {busy === 'search' ? 'Buscando…' : 'Buscar'}
        </button>
      </div>
      {results?.map((r) => (
        <div key={r.site} className="catalog-site">
          <div className="catalog-site-name">{CATALOG_SITES[r.site]}</div>
          {r.error && <p className="error">{r.error}</p>}
          {!r.error && !r.matches.length && <p className="hint">Nada encontrado com esse nome.</p>}
          {r.matches.map((m) => {
            // The same work already in the library under another name.
            const twin = others.find((o) => isSameWork(o.names, m))
            return (
              <label key={m.url} className={chosen.has(m.url) ? 'catalog-match chosen' : 'catalog-match'}>
                <input type="radio" checked={chosen.has(m.url)} onChange={() => undefined} onClick={() => toggle(m)} />
                {m.thumb ? <img src={m.thumb} alt="" /> : <span className="catalog-nocover">📚</span>}
                <span className="catalog-text">
                  <strong>{m.title}</strong>
                  {m.latest !== null && <span className="hint"> · cap. {m.latest}</span>}
                  {m.altNames.length > 0 && <span className="hint catalog-alts">{m.altNames.slice(0, 6).join(' · ')}</span>}
                  {twin && <span className="catalog-twin">Também está na biblioteca como "{displayName(twin.names[0])}": junte as duas abaixo.</span>}
                </span>
              </label>
            )
          })}
        </div>
      ))}
      {results && (
        <div className="row">
          <button onClick={link} disabled={!!busy || chosen.size === 0}>
            {busy === 'link' ? 'Vinculando…' : `Usar ${chosen.size === 1 ? 'o escolhido' : `os ${chosen.size} escolhidos`}`}
          </button>
          <span className="hint">Um por site; clique de novo para desmarcar.</span>
        </div>
      )}
    </>
  )
}

/**
 * The search on top of every page of the scans (Ctrl+K): the library's works by any of their names,
 * and the name looked up on the sites to translate or download its chapters.
 */
export function QuickSearch({
  data,
  onPick,
  onSites,
  onClose
}: {
  data: LibraryData
  onPick: (workId: string) => void
  onSites: (query: string) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [at, setAt] = useState(0)
  const query = normalizeName(search)
  const found = query ? data.groups.filter((g) => g.work.names.some((n) => normalizeName(n).includes(query))).slice(0, 8) : []
  // The last choice is the sites' search, when something was typed.
  const choices = found.length + (search.trim() ? 1 : 0)
  const choose = (i: number) => {
    if (i < found.length) onPick(found[i].work.id)
    else if (search.trim()) onSites(search.trim())
  }

  return (
    <div className="modal-backdrop quick-backdrop" onMouseDown={onClose}>
      <div className="quick-search" onMouseDown={(e) => e.stopPropagation()}>
        <input
          type="search"
          autoFocus
          placeholder="Buscar obra por qualquer nome…"
          value={search}
          onChange={(e) => (setSearch(e.target.value), setAt(0))}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setAt((i) => Math.min(choices - 1, i + 1))
            else if (e.key === 'ArrowUp') setAt((i) => Math.max(0, i - 1))
            else if (e.key === 'Enter') choose(at)
            else return
            e.preventDefault()
          }}
        />
        {found.map((g, i) => (
          <button key={g.work.id} className={`quick-result ${i === at ? 'active' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => choose(i)}>
            <Cover src={coverOf(g, data.covers)} className="thumb" />
            <span className="quick-text">
              <strong>{displayName(g.work.names[0])}</strong>
              <span>{metaLine(g, data.latest.get(g.work.id))}</span>
            </span>
          </button>
        ))}
        {search.trim() && (
          <button className={`quick-result quick-sites ${at === found.length ? 'active' : ''}`} onMouseEnter={() => setAt(found.length)} onClick={() => choose(found.length)}>
            <span className="quick-icon">⌕</span>
            <span className="quick-text">
              <strong>Buscar “{search.trim()}” nos sites</strong>
              <span>MangaDex e mgeko: traduzir ou baixar capítulos</span>
            </span>
          </button>
        )}
        {!search.trim() && <p className="hint">Digite o nome da obra. ↑ ↓ para escolher, Enter para abrir.</p>}
      </div>
    </div>
  )
}
