import { useState } from 'react'
import { languageLabel, type LibraryEntry } from '../../../shared/types'
import { displayName, type Work } from '../../../shared/works'

interface Props {
  entries: LibraryEntry[]
  works: Work[]
  onOpen: (entry: LibraryEntry) => void
  onDownload: (entry: LibraryEntry) => void
  onDelete: (entry: LibraryEntry) => void
  /** Called after names, merges or moves changed the works. */
  onWorksChanged: () => void
}

/** The library grouped by work, chapters in reading order; works can be renamed, merged and chapters moved. */
export function LibraryView({ entries, works, onOpen, onDownload, onDelete, onWorksChanged }: Props) {
  if (entries.length === 0) {
    return <p className="hint center">Os capítulos que você traduzir ficam salvos aqui para ler de novo.</p>
  }
  const groups = works
    .map((work) => ({ work, chapters: entries.filter((e) => e.workId === work.id).sort(byChapter) }))
    .filter((g) => g.chapters.length > 0)
    // The work read most recently first.
    .sort((a, b) => Math.max(...b.chapters.map((c) => c.createdAt)) - Math.max(...a.chapters.map((c) => c.createdAt)))
  const shown = groups.map((g) => g.work)

  return (
    <div className="works">
      {groups.map(({ work, chapters }) => (
        <WorkSection
          key={work.id}
          work={work}
          chapters={chapters}
          others={shown.filter((w) => w.id !== work.id)}
          onOpen={onOpen}
          onDownload={onDownload}
          onDelete={onDelete}
          onWorksChanged={onWorksChanged}
        />
      ))}
    </div>
  )
}

function WorkSection({
  work,
  chapters,
  others,
  onOpen,
  onDownload,
  onDelete,
  onWorksChanged
}: {
  work: Work
  chapters: LibraryEntry[]
  others: Work[]
} & Omit<Props, 'entries' | 'works'>) {
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(true)
  const aliases = work.names.slice(1)
  const latest = [...chapters].sort((a, b) => b.createdAt - a.createdAt)[0]

  return (
    <section className="work">
      <div className="work-head">
        <button className="work-cover" onClick={() => setOpen(!open)} title={open ? 'Recolher' : 'Mostrar capítulos'}>
          {latest.cover ? <img src={latest.cover} alt="" /> : <span>📚</span>}
        </button>
        <div className="work-info">
          <h3>{displayName(work.names[0])}</h3>
          {aliases.length > 0 && (
            <div className="work-aliases" title="Outros nomes desta obra">
              também: {aliases.map(displayName).join(' · ')}
            </div>
          )}
          <div className="work-count">
            {chapters.length} {chapters.length === 1 ? 'capítulo' : 'capítulos'}
            {chapterRange(chapters)}
          </div>
        </div>
        <div className="work-buttons">
          <button className="secondary small" onClick={() => setEditing(!editing)}>
            {editing ? 'Fechar' : 'Nomes'}
          </button>
          <button className="secondary small" onClick={() => setOpen(!open)}>
            {open ? '▴' : '▾'}
          </button>
        </div>
      </div>

      {editing && <WorkEditor work={work} others={others} onDone={() => (setEditing(false), onWorksChanged())} />}

      {open && (
        <div className="library-grid">
          {chapters.map((entry) => (
            <div key={entry.id} className="library-card">
              <button className="library-cover" onClick={() => onOpen(entry)} title="Ler">
                {entry.cover ? <img src={entry.cover} alt={entry.title} /> : <span>📖</span>}
              </button>
              <div className="library-info">
                <strong title={entry.title}>{entry.chapter !== null ? `Capítulo ${entry.chapter}` : entry.title}</strong>
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

/** Edits the names a work is recognized by, or merges another work (same title in another language/site) into it. */
function WorkEditor({ work, others, onDone }: { work: Work; others: Work[]; onDone: () => void }) {
  const [text, setText] = useState(work.names.join('\n'))
  const [mergeId, setMergeId] = useState('')
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

  return (
    <div className="work-editor">
      <label className="field-label">Nomes da obra, um por linha (o primeiro é o principal)</label>
      <textarea rows={Math.min(8, Math.max(3, work.names.length + 1))} value={text} onChange={(e) => setText(e.target.value)} />
      <p className="hint">
        Capítulos novos com qualquer um desses nomes, ou com o começo deles (nomes cortados), entram nesta obra. Adicione os
        nomes usados em outros sites e idiomas.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button onClick={save}>Salvar nomes</button>
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
