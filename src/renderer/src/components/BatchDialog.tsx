import { useState } from 'react'
import { CATALOG_SITES, type CatalogMatch, type CatalogResult } from '../../../shared/catalog'
import type { ReadingRecord } from '../../../shared/reading'
import type { ChapterLink } from '../../../shared/updates'
import { displayName, findWork, type Work } from '../../../shared/works'

interface Props {
  works: Work[]
  reading: ReadingRecord[]
  onClose: () => void
}

const label = (n: number): string => String(n)

/**
 * Translating a range of a work's chapters in a row (overnight, say): the work is looked up on
 * MangaDex and mgeko, the person picks where to take it from and which chapters, and they join the
 * queue the app works through one at a time.
 */
export function BatchDialog({ works, reading, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogResult[] | null>(null)
  const [picked, setPicked] = useState<CatalogMatch | null>(null)
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

  async function pick(match: CatalogMatch) {
    setPicked(match)
    setChapters(null)
    setError(null)
    setBusy(`Lendo os capítulos no ${CATALOG_SITES[match.site]}…`)
    try {
      const list = await window.api.works.chapters({ site: match.site, url: match.url })
      setChapters(list)
      if (!list.length) setError(`Não encontrei capítulos dessa obra no ${CATALOG_SITES[match.site]}.`)
      // From the one after the last read, when the work is in the library.
      const start = list.find((c) => c.chapter > lastRead) ?? list[0]
      setFrom(start ? label(start.chapter) : '')
      setTo(list.length ? label(list[list.length - 1].chapter) : '')
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy(null)
    }
  }

  const low = parseFloat(from.replace(',', '.'))
  const high = parseFloat(to.replace(',', '.'))
  const range = chapters && Number.isFinite(low) && Number.isFinite(high) ? chapters.filter((c) => c.chapter >= low && c.chapter <= high) : []

  async function queue() {
    if (!picked || !range.length) return
    await window.api.remote.batch(workName, picked.site, range)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal batch-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Traduzir vários capítulos</h2>
        <p className="hint">
          Diga a obra, escolha de qual site pegar e a faixa de capítulos: eles são traduzidos um por vez, em ordem, e vão para a
          biblioteca. Dá para pausar a qualquer momento (libera a placa de vídeo) e continuar depois.
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
                <input type="radio" name="batch-match" checked={picked?.url === m.url} onChange={() => pick(m)} disabled={!!busy} />
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

        {busy && <p className="hint">{busy}</p>}
        {error && <p className="error">{error}</p>}

        {picked && chapters && chapters.length > 0 && (
          <>
            <label className="field-label" style={{ marginTop: 14 }}>
              Capítulos a traduzir{lastRead ? ` (você leu até o ${label(lastRead)})` : ''}
            </label>
            <div className="row batch-range">
              <span>do</span>
              <input type="text" inputMode="decimal" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span>ao</span>
              <input type="text" inputMode="decimal" value={to} onChange={(e) => setTo(e.target.value)} />
              <span className="hint">
                {range.length} {range.length === 1 ? 'capítulo' : 'capítulos'}, salvos como "{workName}"
              </span>
            </div>
          </>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="secondary" onClick={onClose}>
            Fechar
          </button>
          <button onClick={queue} disabled={!range.length || !!busy}>
            Traduzir {range.length || ''} em ordem
          </button>
        </div>
      </div>
    </div>
  )
}
