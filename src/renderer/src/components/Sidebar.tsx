import type { ReactNode } from 'react'

export type Page = { kind: 'home' } | { kind: 'library' } | { kind: 'updates' } | { kind: 'work'; id: string }

interface Props {
  page: Page
  /** Works with a new chapter out, shown on the notices' entry. */
  fresh: number
  onPage: (page: Page) => void
  onBatch: () => void
  onPhone: () => void
  onAi: () => void
  onStorage: () => void
  onSettings: () => void
  onSearch: () => void
}

/** The app's way around, down the left side as on MangaDex. */
export function Sidebar({ page, fresh, onPage, onBatch, onPhone, onAi, onStorage, onSettings, onSearch }: Props) {
  const at = page.kind === 'work' ? 'library' : page.kind
  return (
    <nav className="sidebar">
      <button className="sidebar-brand" onClick={() => onPage({ kind: 'home' })}>
        <span className="logo">漫</span>
        <span>Manga Index</span>
      </button>

      <button className="sidebar-search" onClick={onSearch} title="Buscar obra (Ctrl+K)">
        <span className="sidebar-icon">{icons.search}</span>
        <span>Buscar obra</span>
        <kbd>Ctrl K</kbd>
      </button>

      <Item icon={icons.home} label="Início" active={at === 'home'} onClick={() => onPage({ kind: 'home' })} />
      <Item icon={icons.bell} label="Novidades" active={at === 'updates'} badge={fresh || undefined} onClick={() => onPage({ kind: 'updates' })} />
      <Item icon={icons.library} label="Biblioteca" active={at === 'library'} onClick={() => onPage({ kind: 'library' })} />

      <div className="sidebar-group mono">Traduzir</div>
      <Item icon={icons.batch} label="Vários capítulos" onClick={onBatch} />

      <div className="sidebar-group mono">App</div>
      <Item icon={icons.phone} label="Celular" onClick={onPhone} />
      <Item icon={icons.gpu} label="IAs e GPU" onClick={onAi} />
      <Item icon={icons.storage} label="Armazenamento" onClick={onStorage} />
      <Item icon={icons.settings} label="Configurações" onClick={onSettings} />
    </nav>
  )
}

function Item({ icon, label, active, badge, onClick }: { icon: ReactNode; label: string; active?: boolean; badge?: number; onClick: () => void }) {
  return (
    <button className={`sidebar-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="sidebar-icon">{icon}</span>
      <span>{label}</span>
      {badge !== undefined && <span className="sidebar-badge">{badge}</span>}
    </button>
  )
}

const svg = (path: ReactNode): ReactNode => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
)

const icons = {
  storage: svg(
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  search: svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  home: svg(<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />),
  bell: svg(
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  library: svg(
    <>
      <path d="M4 19V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2" />
      <path d="M8 7h6" />
    </>
  ),
  batch: svg(
    <>
      <rect x="3" y="3" width="13" height="13" rx="2" />
      <path d="M8 21h11a2 2 0 0 0 2-2V8" />
    </>
  ),
  phone: svg(
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  gpu: svg(
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </>
  ),
  settings: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  )
}
