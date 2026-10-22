import type { PageState } from '../lib/pipeline'

interface Props {
  pages: PageState[]
  onRetry?: (pageNumber: number) => void
}

const STATUS_LABEL: Record<PageState['status'], string> = {
  pending: 'Na fila',
  working: 'Traduzindo…',
  done: 'Pronta',
  error: 'Erro',
  skipped: 'Não traduzida'
}

export function ProgressView({ pages, onRetry }: Props) {
  return (
    <div className="progress-view">
      <div className="page-grid">
        {pages.map((page) => (
          <div key={page.number} className={`page-card ${page.status}`} title={page.error?.detail ?? page.error?.message}>
            <div className="page-thumb">
              {page.thumbUrl ? (
                <img src={page.thumbUrl} alt={`Página ${page.number}`} />
              ) : (
                <div className="spinner-slot">{page.status === 'working' && <span className="spinner" />}</div>
              )}
            </div>
            <div className="page-meta">
              <span>Pág. {page.number}</span>
              <span className={`status ${page.status}`}>{page.status === 'error' ? STATUS_LABEL.error : statusText(page)}</span>
            </div>
            {page.error && <p className="page-error">{page.error.message}</p>}
            {page.status === 'error' && onRetry && (
              <button className="secondary small page-retry" onClick={() => onRetry(page.number)}>
                Tentar de novo
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export function statusText(page: PageState): string {
  if (page.status === 'working' && page.parts && page.parts.total > 1 && (!page.stage || page.stage === 'Traduzindo')) {
    return `Traduzindo ${page.parts.done}/${page.parts.total}`
  }
  if (page.status === 'working' && page.stage) return page.stage
  if (page.status === 'done') {
    const seconds = page.ms ? ` · ${Math.round(page.ms / 1000)}s` : ''
    return `${page.blockCount ?? 0} textos${seconds}`
  }
  if (page.status === 'error' && page.error) return `Erro: ${page.error.message}`
  return STATUS_LABEL[page.status]
}
