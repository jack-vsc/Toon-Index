import { useState } from 'react'
import type { ReadingRecord } from '../../../shared/reading'
import { languageLabel, type LibraryEntry } from '../../../shared/types'
import { MAX_SOURCES, sourceFromChapter, unreadUpdates, type UpdatesStatus, type WorkUpdate } from '../../../shared/updates'
import { displayName, normalizeName, type Work } from '../../../shared/works'
import { HistoryImport } from './HistoryImport'

interface Props {
  entries: LibraryEntry[]
  works: Work[]
  reading: ReadingRecord[]
  updates: UpdatesStatus | null
  onOpen: (entry: LibraryEntry) => void
  onDownload: (entry: LibraryEntry) => void
  onDelete: (entry: LibraryEntry) => void
  /** Called after names, merges, moves or reading marks changed. */
  onWorksChanged: () => void
}

/**
 * The library grouped by work: chapters translated here, in reading order, and where each work was
 * left in the browser. Works can be renamed, merged and chapters moved.
 */
export function LibraryView({ entries, works, reading, updates, onOpen, onDownload, onDelete, onWorksChanged }: Props) {
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const [help, setHelp] = useState(false)

  const query = normalizeName(search)
  const fresh = new Map(unreadUpdates(updates?.updates ?? {}, reading).map((u) => [u.workId, u]))
  const all = works
    .map((work) => ({
      work,
      chapters: entries.filter((e) => e.workId === work.id).sort(byChapter),
      records: reading.filter((r) => r.workId === work.id).sort((a, b) => a.chapter - b.chapter)
    }))
    .filter((g) => g.chapters.length > 0 || g.records.length > 0)
  const groups = all
    .filter((g) => !query || g.work.names.some((n) => normalizeName(n).includes(query)))
    // Works with a new chapter out first, then the one read most recently.
    .sort((a, b) => Number(fresh.has(b.work.id)) - Number(fresh.has(a.work.id)) || lastActivity(b) - lastActivity(a))
  const shown = all.map((g) => g.work)

  return (
    <>
      <div className="library-toolbar">
        <input type="search" placeholder="Buscar obra por qualquer nome…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="secondary small" onClick={() => setImporting(true)}>
          Importar histórico
        </button>
        <button className="secondary small" onClick={() => setHelp(!help)}>
          Extensão do navegador
        </button>
        <button
          className="secondary small"
          disabled={updates?.running}
          onClick={() => window.api.updates.check()}
          title={updates?.lastRun ? `Última checagem: ${new Date(updates.lastRun).toLocaleString('pt-BR')} (a cada 2 horas)` : 'Checa os sites de cada obra a cada 2 horas'}
        >
          {updates?.running ? 'Checando sites…' : 'Checar capítulos novos'}
        </button>
      </div>
      {help && <ExtensionHelp onClose={() => setHelp(false)} />}
      {importing && <HistoryImport onClose={() => setImporting(false)} onImported={onWorksChanged} />}

      {entries.length === 0 && reading.length === 0 && (
        <p className="hint center">
          Os capítulos que você traduzir ficam salvos aqui, junto com onde você parou em cada obra lida no navegador.
        </p>
      )}
      {(entries.length > 0 || reading.length > 0) && groups.length === 0 && <p className="hint center">Nenhuma obra com esse nome.</p>}

      <div className="works">
        {groups.map(({ work, chapters, records }) => (
          <WorkSection
            key={work.id}
            work={work}
            chapters={chapters}
            records={records}
            update={fresh.get(work.id) ?? null}
            checks={updates?.checks ?? {}}
            others={shown.filter((w) => w.id !== work.id)}
            onOpen={onOpen}
            onDownload={onDownload}
            onDelete={onDelete}
            onWorksChanged={onWorksChanged}
          />
        ))}
      </div>
    </>
  )
}

function lastActivity(g: { chapters: LibraryEntry[]; records: ReadingRecord[] }): number {
  return Math.max(0, ...g.chapters.map((c) => c.createdAt), ...g.records.map((r) => r.updatedAt))
}

function ExtensionHelp({ onClose }: { onClose: () => void }) {
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

function WorkSection({
  work,
  chapters,
  records,
  update,
  checks,
  others,
  onOpen,
  onDownload,
  onDelete,
  onWorksChanged
}: {
  work: Work
  chapters: LibraryEntry[]
  records: ReadingRecord[]
  /** A chapter out past the last one read. */
  update: WorkUpdate | null
  checks: UpdatesStatus['checks']
  others: Work[]
} & Omit<Props, 'entries' | 'works' | 'reading' | 'updates'>) {
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(chapters.length > 0)
  const aliases = work.names.slice(1)
  const latest = [...chapters].sort((a, b) => b.createdAt - a.createdAt)[0]
  const status = readingStatus(records)
  const readChapters = new Set(records.filter((r) => r.status === 'read').map((r) => r.chapter))

  return (
    <section className="work">
      <div className="work-head">
        <button className="work-cover" onClick={() => setOpen(!open)} title={open ? 'Recolher' : 'Mostrar capítulos'}>
          {latest?.cover ? <img src={latest.cover} alt="" /> : <span>📚</span>}
        </button>
        <div className="work-info">
          <h3>
            {displayName(work.names[0])}
            {work.format === 'novel' && <span className="format-tag">novel</span>}
          </h3>
          {aliases.length > 0 && (
            <div className="work-aliases" title="Outros nomes desta obra">
              também: {aliases.map(displayName).join(' · ')}
            </div>
          )}
          {status && <div className="work-reading">{status.text}</div>}
          {update && (
            <div className="work-new">
              🆕 Capítulo {update.latest} saiu em {update.site}{' '}
              <button className="link" onClick={() => window.open(update.url)}>
                abrir
              </button>
            </div>
          )}
          {chapters.length > 0 && (
            <div className="work-count">
              {chapters.length} {chapters.length === 1 ? 'capítulo traduzido' : 'capítulos traduzidos'}
              {chapterRange(chapters)}
            </div>
          )}
        </div>
        <div className="work-buttons">
          {status?.continueUrl && (
            <button className="small" onClick={() => window.open(status.continueUrl)} title={status.continueUrl}>
              Continuar
            </button>
          )}
          <button className="secondary small" onClick={() => setEditing(!editing)}>
            {editing ? 'Fechar' : 'Editar'}
          </button>
          <button className="secondary small" onClick={() => setOpen(!open)}>
            {open ? '▴' : '▾'}
          </button>
        </div>
      </div>

      {editing && (
        <WorkEditor
          work={work}
          others={others}
          records={records}
          checks={checks}
          onDone={() => (setEditing(false), onWorksChanged())}
        />
      )}

      {open && records.length > 0 && (
        <div className="reading-chips">
          {records.map((r) => (
            <button
              key={r.chapter}
              className={`reading-chip ${r.status}`}
              disabled={!r.url}
              onClick={() => window.open(r.url)}
              title={`${r.status === 'read' ? 'Lido' : 'Em andamento'} · ${siteOf(r.url) || sourceLabel(r.source)} · ${new Date(r.updatedAt).toLocaleString('pt-BR')}`}
            >
              {r.chapter}
              {r.status === 'read' ? ' ✓' : r.progress !== null ? ` · ${Math.round(r.progress * 100)}%` : ' · …'}
            </button>
          ))}
        </div>
      )}

      {open && chapters.length > 0 && (
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
      )}
    </section>
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
