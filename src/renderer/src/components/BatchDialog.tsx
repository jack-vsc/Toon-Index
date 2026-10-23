import { useState } from 'react'
import { CATALOG_SITES, type CatalogResult, type CatalogSite } from '../../../shared/catalog'
import type { ReadingRecord } from '../../../shared/reading'
import type { ChapterLink } from '../../../shared/updates'
import { displayName, findWork, type Work } from '../../../shared/works'

interface Props {
  works: Work[]
  reading: ReadingRecord[]
  onClose: () => void
}

const label = (n: number): string => String(n)

/** Where the chapters come from: a work found on MangaDex or mgeko, or a work's page on any site. */
interface Source {
  site: CatalogSite | 'link'
  url: string
  title: string
}

const siteName = (source: Source): string => (source.site === 'link' ? new URL(source.url).hostname.replace(/^www\./, '') : CATALOG_SITES[source.site])

/**
 * A range of a work's chapters in a row: translated (overnight, say) or only downloaded (a scan already
 * in Portuguese, to read offline). The work is looked up on MangaDex and mgeko, or its page on any site
 * is given (signing in there first when the site asks); the chapters join the queue the app works through
 * one at a time.
 */
export function BatchDialog({ works, reading, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogResult[] | null>(null)
  const [picked, setPicked] = useState<Source | null>(null)
  const [link, setLink] = useState('')
  const [download, setDownload] = useState(false)
  const [chapters, setChapters] = useState<ChapterLink[] | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Chapters land in the library under the name typed (or the library's own name for that work).
  const known = query.trim() ? findWork(works, query.trim()) : null
  const workName = known ? displayName(known.names[0]) : query.trim()
  const lastRead = known
    ? Math.max(0, ...reading.filter((r) => r.workId === known.id && r.status === 'read').map((r) => r.chapter))
    : 0

  async function search() {
    if (!query.trim()) return
    setBusy('Buscando nos sites…')
    setError(null)
    setPicked(null)
    setChapters(null)
    try {
      setResults(await window.api.works.search(query))
    } finally {
      setBusy(null)
    }
  }

  async function pick(match: Source) {
    setPicked(match)
    setChapters(null)
    setError(null)
    setBusy(`Lendo os capítulos no ${siteName(match)}…`)
    try {
      const list = await window.api.works.chapters({ site: match.site, url: match.url })
      setChapters(list)
      if (!list.length) setError(`Não encontrei capítulos dessa obra no ${siteName(match)}. Confira se o link é o da página da obra, a que lista os capítulos.`)
      // From the one after the last read, when the work is in the library.
      const start = list.find((c) => c.chapter > lastRead) ?? list[0]
      setFrom(start ? label(start.chapter) : '')
      setTo(list.length ? label(list[list.length - 1].chapter) : '')
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(null)
    }
  }

  const low = parseFloat(from.replace(',', '.'))
  const high = parseFloat(to.replace(',', '.'))
  const range = chapters && Number.isFinite(low) && Number.isFinite(high) ? chapters.filter((c) => c.chapter >= low && c.chapter <= high) : []

  async function queue() {
    if (!picked || !range.length) return
    // The work's page joins its sites, so its new chapters are announced from there too.
    await window.api.remote.batch(workName || picked.title, picked.site === 'link' ? siteName(picked) : picked.site, range, download, picked.url)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal batch-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Vários capítulos</h2>
        <p className="hint">
          Diga a obra, escolha de onde pegar e a faixa de capítulos: eles são traduzidos (ou só baixados) um por vez, em ordem, e vão
          para a biblioteca, de onde o celular baixa para ler sem internet. Dá para pausar a qualquer momento e continuar depois.
        </p>

        <div className="row">
          <input
            type="search"
            list="batch-works"
            placeholder="Nome da obra"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <datalist id="batch-works">
            {works.map((w) => (
              <option key={w.id} value={displayName(w.names[0])} />
            ))}
          </datalist>
          <button onClick={search} disabled={!!busy || !query.trim()}>
            Buscar
          </button>
        </div>

        {results?.map((r) => (
          <div key={r.site} className="catalog-site">
            <div className="catalog-site-name">{CATALOG_SITES[r.site]}</div>
            {r.error && <p className="error">{r.error}</p>}
            {!r.error && !r.matches.length && <p className="hint">Nada encontrado com esse nome.</p>}
            {r.matches.map((m) => (
              <label key={m.url} className={picked?.url === m.url ? 'catalog-match chosen' : 'catalog-match'}>
                <input
                  type="radio"
                  name="batch-match"
                  checked={picked?.url === m.url}
                  onChange={() => (setDownload(false), pick(m))}
                  disabled={!!busy}
                />
                {m.thumb ? <img src={m.thumb} alt="" /> : <span className="catalog-nocover">📚</span>}
                <span className="catalog-text">
                  <strong>{m.title}</strong>
                  <span className="hint">
                    {picked?.url === m.url && chapters
                      ? `${chapters.length} capítulos no site${chapters.length ? ` (${label(chapters[0].chapter)} a ${label(chapters[chapters.length - 1].chapter)})` : ''}`
                      : m.latest !== null
                        ? `até o cap. ${m.latest}`
                        : 'escolha para ver os capítulos'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ))}

        <label className="field-label" style={{ marginTop: 14 }}>
          Ou o link da obra num site (uma scan em português, por exemplo): a página que lista os capítulos
        </label>
        <div className="row">
          <input type="url" placeholder="https://site.com/obra/nome-da-obra" value={link} onChange={(e) => setLink(e.target.value)} />
          <button
            className="secondary"
            disabled={!!busy || !/^https?:\/\//.test(link.trim())}
            title="Abre o site numa janela do app para você entrar na sua conta; o app guarda a sessão, não a senha"
            onClick={async () => {
              setBusy('Entre na sua conta na janela do site e feche-a quando terminar…')
              try {
                await window.api.web.login(link.trim())
              } finally {
                setBusy(null)
              }
            }}
          >
            Entrar no site
          </button>
          <button
            disabled={!!busy || !/^https?:\/\//.test(link.trim())}
            onClick={() => {
              setDownload(true)
              void pick({ site: 'link', url: link.trim(), title: query.trim() })
            }}
          >
            Ler capítulos
          </button>
        </div>
        {picked?.site === 'link' && chapters && chapters.length > 0 && (
          <p className="hint">
            {chapters.length} capítulos em {siteName(picked)} ({label(chapters[0].chapter)} a {label(chapters[chapters.length - 1].chapter)})
          </p>
        )}

        {busy && <p className="hint">{busy}</p>}
        {error && <p className="error">{error}</p>}

        {picked && chapters && chapters.length > 0 && (
          <>
            <label className="field-label" style={{ marginTop: 14 }}>
              Capítulos a {download ? 'baixar' : 'traduzir'}{lastRead ? ` (você leu até o ${label(lastRead)})` : ''}
            </label>
            <div className="row batch-range">
              <span>do</span>
              <input type="text" inputMode="decimal" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span>ao</span>
              <input type="text" inputMode="decimal" value={to} onChange={(e) => setTo(e.target.value)} />
              <span className="hint">
                {range.length} {range.length === 1 ? 'capítulo' : 'capítulos'}, salvos como "{workName || picked.title || '?'}"
              </span>
            </div>
            <div className="segmented small batch-mode">
              <button className={!download ? 'active' : ''} onClick={() => setDownload(false)}>
                Traduzir
              </button>
              <button className={download ? 'active' : ''} onClick={() => setDownload(true)}>
                Só baixar (já está em português)
              </button>
            </div>
          </>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="secondary" onClick={onClose}>
            Fechar
          </button>
          <button onClick={queue} disabled={!range.length || !!busy || !(workName || picked?.title)}>
            {download ? 'Baixar' : 'Traduzir'} {range.length || ''} em ordem
          </button>
        </div>
      </div>
    </div>
  )
}
