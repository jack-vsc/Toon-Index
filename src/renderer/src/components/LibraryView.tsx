import { languageLabel, type LibraryEntry } from '../../../shared/types'

interface Props {
  entries: LibraryEntry[]
  onOpen: (entry: LibraryEntry) => void
  onDownload: (entry: LibraryEntry) => void
  onDelete: (entry: LibraryEntry) => void
}

export function LibraryView({ entries, onOpen, onDownload, onDelete }: Props) {
  if (entries.length === 0) {
    return <p className="hint center">Os capítulos que você traduzir ficam salvos aqui para ler de novo.</p>
  }

  return (
    <div className="library-grid">
      {entries.map((entry) => (
        <div key={entry.id} className="library-card">
          <button className="library-cover" onClick={() => onOpen(entry)} title="Ler">
            {entry.cover ? <img src={entry.cover} alt={entry.title} /> : <span>📖</span>}
          </button>
          <div className="library-info">
            <strong title={entry.title}>{entry.title}</strong>
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
        </div>
      ))}
    </div>
  )
}
