import { useEffect, useState, type ReactNode } from 'react'
import { CATALOG_SITES, isSameWork, type CatalogMatch, type CatalogResult } from '../../../shared/catalog'
import type { ReadingRecord } from '../../../shared/reading'
import { languageLabel, type LibraryEntry } from '../../../shared/types'
import { MAX_SOURCES, sourceFromChapter, unreadUpdates, type UpdatesStatus, type WorkUpdate } from '../../../shared/updates'
import { displayName, normalizeName, type Work } from '../../../shared/works'
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

  // Covers found on the catalog sites; they come as works are looked up there.
  useEffect(() => {
    window.api.works.covers().then(setCovers)
  }, [works])

  const fresh = new Map(unreadUpdates(updates?.updates ?? {}, reading).map((u) => [u.workId, u]))
  const groups = works
    .map((work) => ({
      work,
      chapters: entries.filter((e) => e.workId === work.id).sort(byChapter),
      records: reading.filter((r) => r.workId === work.id).sort((a, b) => a.chapter - b.chapter)
    }))
    .filter((g) => g.chapters.length > 0 || g.records.length > 0)
    .sort((a, b) => Number(fresh.has(b.work.id)) - Number(fresh.has(a.work.id)) || lastActivity(b) - lastActivity(a))
  return { groups, fresh, covers }
}

/** The work's own cover, or its latest translated chapter's. */
function coverOf(group: WorkGroup, covers: Record<string, string>): string | null {
  return covers[group.work.id] ?? [...group.chapters].sort((a, b) => b.createdAt - a.createdAt)[0]?.cover ?? null
}

/** "CAP. 90 · NOVEL · 5 TRADUZIDOS", in the sites' small capitals. */
function metaLine(group: WorkGroup): string {
  const read = group.records.filter((r) => r.status === 'read').map((r) => r.chapter)
  const parts = [read.length ? `CAP. ${Math.max(...read)}` : group.records.length ? 'LENDO' : 'NÃO LIDO']
  if (group.work.format === 'novel') parts.push('NOVEL')
  if (group.chapters.length) parts.push(`${group.chapters.length} TRAD.`)
  return parts.join(' · ')
}

function Cover({ src, className }: { src: string | null; className: string }) {
  return <div className={className}>{src ? <img src={src} alt="" /> : <span>📚</span>}</div>
}

/** The library as a wall of covers; a cover opens the work's page. */
export function LibraryView({ data, updates, onPick, onWorksChanged }: { data: LibraryData; updates: UpdatesStatus | null; onPick: (workId: string) => void; onWorksChanged: () => void }) {
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const [help, setHelp] = useState(false)
  const query = normalizeName(search)
  const groups = data.groups.filter((g) => !query || g.work.names.some((n) => normalizeName(n).includes(query)))

  return (
    <div className="page">
      <div className="page-head">
        <h1>Biblioteca</h1>
        <span className="mono muted">{data.groups.length} OBRAS</span>
      </div>
      <div className="library-toolbar">
        <input type="search" placeholder="Buscar obra por qualquer nome…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="secondary small" onClick={() => setImporting(true)}>
          Importar histórico
        </button>
        <button className="secondary small" onClick={() => setHelp(!help)}>
          Extensão do navegador
        </button>
        <CheckButton updates={updates} />
      </div>
      {help && <ExtensionHelp onClose={() => setHelp(false)} />}
      {importing && <HistoryImport onClose={() => setImporting(false)} onImported={onWorksChanged} />}

      {data.groups.length === 0 && (
        <p className="hint center">Os capítulos que você traduzir ficam aqui, junto com onde você parou em cada obra lida no navegador.</p>
      )}
      {data.groups.length > 0 && groups.length === 0 && <p className="hint center">Nenhuma obra com esse nome.</p>}

      <div className="poster-grid">
        {groups.map((g) => (
          <PosterCard key={g.work.id} group={g} cover={coverOf(g, data.covers)} update={data.fresh.get(g.work.id) ?? null} onPick={() => onPick(g.work.id)} />
        ))}
      </div>
    </div>
  )
}

function CheckButton({ updates }: { updates: UpdatesStatus | null }) {
  return (
    <button
      className="secondary small"
      disabled={updates?.running}
      onClick={() => window.api.updates.check()}
      title={updates?.lastRun ? `Última checagem: ${new Date(updates.lastRun).toLocaleString('pt-BR')} (a cada 2 horas)` : 'Checa os sites de cada obra a cada 2 horas'}
    >
      {updates?.running ? 'Checando sites…' : 'Checar capítulos novos'}
    </button>
  )
}

function PosterCard({ group, cover, update, onPick }: { group: WorkGroup; cover: string | null; update: WorkUpdate | null; onPick: () => void }) {
  return (
    <button className="poster-card" onClick={onPick} title={group.work.names.map(displayName).join('\n')}>
      <div className="poster">
        {cover ? <img src={cover} alt="" /> : <span>📚</span>}
        {update && <span className="poster-badge mono">NOVO · {update.latest}</span>}
      </div>
      <div className="poster-title">{displayName(group.work.names[0])}</div>
      <div className="poster-meta mono">{metaLine(group)}</div>
    </button>
  )
}

/**
 * The first page: the work being read now, new chapters out, translating, and the works read lately.
 */
export function HomeFeed({ data, updates, onPick, children }: { data: LibraryData; updates: UpdatesStatus | null; onPick: (workId: string) => void; children: ReactNode }) {
  const recent = [...data.groups].sort((a, b) => lastActivity(b) - lastActivity(a))
  const current = recent.find((g) => readingStatus(g.records)?.continueUrl) ?? recent[0]
  const fresh = [...data.fresh.values()]
    .map((u) => ({ update: u, group: data.groups.find((g) => g.work.id === u.workId) }))
    .filter((f): f is { update: WorkUpdate; group: WorkGroup } => !!f.group)

  return (
    <div className="page">
      {current && <Hero group={current} cover={coverOf(current, data.covers)} update={data.fresh.get(current.work.id) ?? null} onPick={() => onPick(current.work.id)} />}

      <section className="home-section">
        <div className="section-head">
          <h2>Capítulos novos</h2>
          <CheckButton updates={updates} />
        </div>
        {fresh.length === 0 ? (
          <p className="hint">
            Nenhum capítulo novo nas obras que você lê. Os sites de cada obra são checados a cada 2 horas
            {updates?.lastRun ? ` (última vez ${timeAgo(updates.lastRun)})` : ''}.
          </p>
        ) : (
          <div className="update-grid">
            {fresh.map(({ update, group }) => (
              <div key={update.workId} className="update-row">
                <button className="update-cover" onClick={() => onPick(group.work.id)}>
                  <Cover src={coverOf(group, data.covers)} className="thumb" />
                </button>
                <div className="update-text">
                  <button className="update-title" onClick={() => onPick(group.work.id)}>
                    {displayName(group.work.names[0])}
                  </button>
                  <span>Capítulo {update.latest}</span>
                  <span className="mono muted">
                    {update.site.toUpperCase()} · {timeAgo(update.checkedAt)}
                  </span>
                </div>
                <button className="small" onClick={() => window.open(update.url)}>
                  Ler
                </button>
              </div>
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
              <PosterCard key={g.work.id} group={g} cover={coverOf(g, data.covers)} update={data.fresh.get(g.work.id) ?? null} onPick={() => onPick(g.work.id)} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** The work being read, big, with where it was left and what came out since. */
function Hero({ group, cover, update, onPick }: { group: WorkGroup; cover: string | null; update: WorkUpdate | null; onPick: () => void }) {
  const status = readingStatus(group.records)
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
          {group.chapters.length > 0 && <span className="tag">{group.chapters.length} TRADUZIDOS</span>}
        </div>
        {status && <p className="hero-status">{status.text}</p>}
        <div className="row">
          {status?.continueUrl && <button onClick={() => window.open(status.continueUrl)}>Continuar</button>}
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
}: { group: WorkGroup; data: LibraryData; updates: UpdatesStatus | null; others: Work[]; onBack: () => void } & Actions) {
  const { work, chapters, records } = group
  const [editing, setEditing] = useState(false)
  const cover = coverOf(group, data.covers)
  const update = data.fresh.get(work.id) ?? null
  const status = readingStatus(records)
  const aliases = work.names.slice(1)
  const rows = chapterRows(records, chapters)

  return (
    <div className="page work-page">
      <section className="work-hero">
        {cover && <div className="hero-bg" style={{ backgroundImage: `url(${cover})` }} />}
        <Cover src={cover} className="poster work-poster" />
        <div className="hero-text">
          <button className="link back" onClick={onBack}>
            ← Biblioteca
          </button>
          <h1>{displayName(work.names[0])}</h1>
          {aliases.length > 0 && <div className="work-aliases">{aliases.map(displayName).join(' · ')}</div>}
          <div className="tags">
            <span className="tag">{work.format === 'novel' ? 'NOVEL' : 'MANGÁ'}</span>
            {(work.catalog?.sites ?? []).map((s) => (
              <span key={s} className="tag">
                {CATALOG_SITES[s]?.toUpperCase() ?? s}
              </span>
            ))}
            {(work.sources ?? []).map((s) => (
              <a key={s} className="tag link-tag" href={s} target="_blank" rel="noreferrer">
                {siteOf(s).toUpperCase()} ↗
              </a>
            ))}
          </div>
          {status && <p className="hero-status">{status.text}</p>}
          <div className="row">
            {status?.continueUrl && <button onClick={() => window.open(status.continueUrl)}>Continuar</button>}
            {update && (
              <button className="secondary" onClick={() => window.open(update.url)}>
                🆕 Ler o cap. {update.latest} ({update.site})
              </button>
            )}
            <button className="secondary" onClick={() => setEditing(!editing)}>
              {editing ? 'Fechar edição' : 'Editar obra'}
            </button>
          </div>
        </div>
      </section>

      {editing && (
        <WorkEditor work={work} others={others} records={records} checks={updates?.checks ?? {}} onDone={() => (setEditing(false), onWorksChanged())} />
      )}

      {rows.length > 0 && (
        <section className="home-section">
          <div className="section-head">
            <h2>Capítulos</h2>
            <span className="mono muted">{rows.length}</span>
          </div>
          <div className="chapter-rows">
            {rows.map(({ chapter, record, entry }) => (
              <div key={chapter} className={`chapter-row ${record?.status === 'read' ? 'read' : ''}`}>
                <span className="chapter-num">Cap. {chapter}</span>
                <span className={`chapter-state ${record?.status ?? ''}`}>
                  {record ? (record.status === 'read' ? '✓ lido' : record.progress !== null ? `${Math.round(record.progress * 100)}%` : 'lendo') : ''}
                </span>
                <span className="mono muted chapter-where">
                  {record ? `${(siteOf(record.url) || sourceLabel(record.source)).toUpperCase()} · ${timeAgo(record.updatedAt)}` : ''}
                </span>
                <span className="chapter-actions">
                  {entry && (
                    <button className="small" onClick={() => onOpen(entry)}>
                      Ler traduzido
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
      )}

      {chapters.length > 0 && (
        <section className="home-section">
          <div className="section-head">
            <h2>Traduzidos neste PC</h2>
            <span className="mono muted">{chapterRange(chapters).replace(/^ · /, '').toUpperCase()}</span>
          </div>
          <TranslatedGrid chapters={chapters} records={records} others={others} onOpen={onOpen} onDownload={onDownload} onDelete={onDelete} onWorksChanged={onWorksChanged} />
        </section>
      )}
    </div>
  )
}

/** Every chapter read or translated, newest first, the reading and the translation of each side by side. */
function chapterRows(records: ReadingRecord[], chapters: LibraryEntry[]): { chapter: number; record?: ReadingRecord; entry?: LibraryEntry }[] {
  const rows = new Map<number, { chapter: number; record?: ReadingRecord; entry?: LibraryEntry }>()
  for (const r of records) rows.set(r.chapter, { chapter: r.chapter, record: r })
  for (const e of chapters) {
    if (e.chapter === null) continue
    rows.set(e.chapter, { ...(rows.get(e.chapter) ?? { chapter: e.chapter }), entry: e })
  }
  return [...rows.values()].sort((a, b) => b.chapter - a.chapter)
}

function TranslatedGrid({ chapters, records, others, onOpen, onDownload, onDelete, onWorksChanged }: { chapters: LibraryEntry[]; records: ReadingRecord[]; others: Work[] } & Actions) {
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
              {languageLabel(entry.sourceLanguage)} → {languageLabel(entry.targetLanguage)}
            </span>
            <span>
              {entry.translatedPages === entry.pageCount ? `${entry.pageCount} páginas` : `${entry.translatedPages} de ${entry.pageCount} páginas traduzidas`} ·{' '}
              {new Date(entry.createdAt).toLocaleDateString('pt-BR')}
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
        Com a extensão, o app marca sozinho os capítulos que você lê em qualquer site: <strong>lido</strong> quando você chega
        ao fim das páginas (ou abre o capítulo seguinte), <strong>em andamento</strong> com a posição quando para no meio. Com o
        app fechado, a extensão guarda as leituras e envia quando ele abrir.
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

/** "Lido até o cap. 53 · parou no cap. 54 (40%) · site.com · há 3 dias", and the page to go back to. */
function readingStatus(records: ReadingRecord[]): { text: string; continueUrl: string } | null {
  if (!records.length) return null
  const read = records.filter((r) => r.status === 'read').map((r) => r.chapter)
  const upTo = read.length ? Math.max(...read) : null
  const current = records
    .filter((r) => r.status === 'reading' && (upTo === null || r.chapter > upTo))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
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
  return { browser: 'navegador', history: 'histórico', app: 'lido no app', manual: 'marcado à mão' }[source]
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
        Capítulos novos com qualquer um desses nomes, ou com o começo deles (nomes cortados), entram nesta obra, seja no app ou
        lidos no navegador. Adicione os nomes usados em outros sites e idiomas.
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
