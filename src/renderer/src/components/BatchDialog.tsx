import { useEffect, useState } from 'react'
import { CATALOG_SITES, RESULT_SITES, type CatalogResult, type CatalogSite } from '../../../shared/catalog'
import type { ReadingRecord } from '../../../shared/reading'
import type { ChapterLink } from '../../../shared/updates'
import { displayName, findWork, type Work } from '../../../shared/works'

interface Props {
  works: Work[]
  reading: ReadingRecord[]
  /** A name to look up on the sites as soon as it opens (from the quick search). */
  initialQuery?: string
  /** A work's next chapters (from its page): its own sites listed, the range from the one after `after`. */
  work?: Work
  after?: number
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

/** A work's own page as a source: MangaDex and mgeko read their own way, any other site from its page. */
function sourceOf(url: string, title: string): Source {
  const host = new URL(url).hostname
  return { site: /(^|\.)mangadex\.org$/.test(host) ? 'mangadex' : /(^|\.)mgeko\.cc$/.test(host) ? 'mgeko' : /(^|\.)mangakakalot\.(fan|gg)$/.test(host) ? 'mangakakalot' : /(^|\.)mangalivre\.blog$/.test(host) ? 'mangalivre' : 'link', url, title }
}

/**
 * A range of a work's chapters in a row: translated (overnight, say) or only downloaded (a scan already
 * in Portuguese, to read offline). The work is looked up on MangaDex and mgeko, or its page on any site
 * is given (signing in there first when the site asks); the chapters join the queue the app works through
 * one at a time.
 */
export function BatchDialog({ works, reading, initialQuery, work, after, onClose }: Props) {
  const [query, setQuery] = useState(work ? displayName(work.names[0]) : (initialQuery ?? ''))
  const ownSources = (work?.sources ?? []).map((url) => sourceOf(url, displayName(work!.names[0])))
  const [results, setResults] = useState<CatalogResult[] | null>(null)
  const [picked, setPicked] = useState<Source | null>(null)
  const [link, setLink] = useState('')
  const [download, setDownload] = useState(false)
  // Chapters on sites are pictures: a novel is translated from its PDFs ("Traduzir PDF"), where its text is.
  const [novel, setNovel] = useState(false)
  const [chapters, setChapters] = useState<ChapterLink[] | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Chapters land in the library under the name typed (or the library's own name for that work).
  const known = query.trim() ? findWork(works, query.trim()) : null
  const workName = known ? displayName(known.names[0]) : query.trim()
  const readUpTo = known
    ? Math.max(0, ...reading.filter((r) => r.workId === known.id && r.status === 'read').map((r) => r.chapter))
    : 0
  // From a work's page: after the last chapter read or already in the library.
  const lastRead = Math.max(readUpTo, after ?? 0)

  useEffect(() => {
    // A work with a single site: its chapters straight away.
    if (ownSources.length === 1) void pick(ownSources[0])
    else if (initialQuery && !work) void search()
  }, [])

  async function search() {
    if (!query.trim()) return
    setBusy('Buscando nos sites…')
    setError(null)
    setPicked(null)
    setChapters(null)
    try {
      setResults(await window.api.works.search(query, true))
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
      const { title, chapters: list, language } = await window.api.works.chapters({ site: match.site, url: match.url })
      setChapters(list)
      // A site in Portuguese: downloaded as it is, not translated.
      if (language) setDownload(/^pt/i.test(language))
      // A link pasted without the work's name: the name its page gives.
      if (title && !match.title) {
        setPicked({ ...match, title })
        if (!query.trim()) setQuery(title)
      }
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
    await window.api.remote.batch(workName || picked.title, picked.site === 'link' ? siteName(picked) : picked.site, range, download, picked.url, { contentType: 'comic' })
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

        {ownSources.length > 0 && (
          <div className="catalog-site">
            <div className="catalog-site-name">Sites da obra{after ? ` · a partir do cap. ${label(nextAfter(chapters, lastRead) ?? lastRead + 1)}` : ''}</div>
            {ownSources.map((m) => (
              <label key={m.url} className={picked?.url === m.url ? 'catalog-match chosen' : 'catalog-match'}>
                <input type="radio" name="batch-match" checked={picked?.url === m.url} onChange={() => pick(m)} disabled={!!busy} />
                <span className="catalog-nocover">🔗</span>
                <span className="catalog-text">
                  <strong>{siteName(m)}</strong>
                  <span className="hint">
                    {picked?.url === m.url && chapters
                      ? `${chapters.length} capítulos no site${chapters.length ? ` (${label(chapters[0].chapter)} a ${label(chapters[chapters.length - 1].chapter)})` : ''}`
                      : 'escolha para ver os capítulos'}
                  </span>
                </span>
              </label>
            ))}
            <p className="hint">Ou busque a obra nos sites abaixo, pelo nome.</p>
          </div>
        )}

        {results?.map((r) => (
          <div key={r.site} className="catalog-site">
            <div className="catalog-site-name">{RESULT_SITES[r.site]}</div>
            {r.error && <p className="error">{r.error}</p>}
            {!r.error && !r.matches.length && <p className="hint">Nada encontrado com esse nome.</p>}
            {r.matches.map((m) => (
              <label key={m.url} className={picked?.url === m.url ? 'catalog-match chosen' : 'catalog-match'}>
                <input
                  type="radio"
                  name="batch-match"
                  checked={picked?.url === m.url}
                  onChange={() => (setDownload(m.site === 'link'), pick(m))}
                  disabled={!!busy}
                />
                {m.thumb ? <img src={m.thumb} alt="" /> : <span className="catalog-nocover">📚</span>}
                <span className="catalog-text">
                  <strong>{m.title}</strong>
                  {m.site === 'link' && <span className="hint">{siteName(m)}</span>}
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
            {!download && (
              <>
                <label className="field-label">Tipo</label>
                <div className="segmented small batch-mode">
                  <button className={!novel ? 'active' : ''} onClick={() => setNovel(false)}>
                    Mangá / webtoon
                  </button>
                  <button className={novel ? 'active' : ''} onClick={() => setNovel(true)}>
                    Novel
                  </button>
                </div>
                <p className={novel ? 'error' : 'hint'}>
                  {novel
                    ? 'Capítulos de site chegam como imagens, sem o texto: o modo novel não teria o que traduzir. Para uma novel, baixe os PDFs e use "Traduzir PDF".'
                    : 'Acha os balões nas imagens, traduz e redesenha o texto por cima.'}
                </p>
              </>
            )}
          </>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="secondary" onClick={onClose}>
            Fechar
          </button>
          <button onClick={queue} disabled={!range.length || !!busy || !(workName || picked?.title) || (novel && !download)}>
            {download ? 'Baixar' : 'Traduzir'} {range.length || ''} em ordem
          </button>
        </div>
      </div>
    </div>
  )
}

/** The first chapter on the site after the last one read (or had). */
function nextAfter(chapters: ChapterLink[] | null, after: number): number | null {
  return chapters?.find((c) => c.chapter > after)?.chapter ?? null
}
