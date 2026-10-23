import { useEffect, useRef, useState } from 'react'
import type { ReaderMode } from '../../../shared/types'

export interface ReaderPage {
  key: string
  number: number
  /** Missing while the page is still being produced. */
  url?: string
  /** height / width */
  aspect: number
  tall: boolean
  /** Shown on the placeholder of a page that has no image yet. */
  status?: string
}

interface Props {
  pages: ReaderPage[]
  mode: ReaderMode
  zoom: number
  /** Called once when the last page is reached. */
  onEnd?: () => void
}

export function Reader({ pages, mode, zoom, onEnd }: Props) {
  const ended = useRef(false)
  const end = () => {
    if (ended.current) return
    ended.current = true
    onEnd?.()
  }
  return mode === 'paged' ? <PagedReader pages={pages} zoom={zoom} onEnd={end} /> : <ScrollReader pages={pages} zoom={zoom} onEnd={end} />
}

function ScrollReader({ pages, zoom, onEnd }: { pages: ReaderPage[]; zoom: number; onEnd: () => void }) {
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!bottom.current) return
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && onEnd())
    observer.observe(bottom.current)
    return () => observer.disconnect()
  }, [onEnd])

  return (
    <div className="reader">
      {pages.map((page) => (
        <PageView key={page.key} page={page} width={`${zoom}%`} className={page.tall ? 'tall' : ''} />
      ))}
      <div ref={bottom} />
    </div>
  )
}

function PagedReader({ pages, zoom, onEnd }: { pages: ReaderPage[]; zoom: number; onEnd: () => void }) {
  const [index, setIndex] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const current = pages[Math.min(index, pages.length - 1)]

  useEffect(() => {
    if (pages.length > 1 && index >= pages.length - 1) onEnd()
  }, [index, pages.length])

  const go = (delta: number) => setIndex((i) => Math.min(pages.length - 1, Math.max(0, i + delta)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1)
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pages.length])

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [index])

  if (!current) return null
  return (
    <div className="paged">
      <div className="paged-page" ref={scroller}>
        <button className="paged-zone left" aria-label="Página anterior" onClick={() => go(-1)} disabled={index === 0} />
        <PageView page={current} width={current.tall ? `${zoom}%` : undefined} className={current.tall ? 'tall' : 'fit'} />
        <button className="paged-zone right" aria-label="Próxima página" onClick={() => go(1)} disabled={index >= pages.length - 1} />
      </div>
      <div className="paged-bar">
        <button className="secondary" onClick={() => go(-1)} disabled={index === 0}>
          ‹ Anterior
        </button>
        <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
          {pages.map((p, i) => (
            <option key={p.key} value={i}>
              Página {p.number}
            </option>
          ))}
        </select>
        <span className="hint">
          {index + 1} / {pages.length}
        </span>
        <button className="secondary" onClick={() => go(1)} disabled={index >= pages.length - 1}>
          Próxima ›
        </button>
      </div>
    </div>
  )
}

function PageView({ page, width, className }: { page: ReaderPage; width?: string; className: string }) {
  if (page.url) return <img src={page.url} alt={`Página ${page.number}`} className={className} style={{ width }} />
  return (
    <div className={`reader-placeholder ${className}`} style={{ width, aspectRatio: `1 / ${page.aspect}` }}>
      <span className="spinner" />
      <span>
        Página {page.number}
        {page.status ? ` · ${page.status}` : ''}
      </span>
    </div>
  )
}
