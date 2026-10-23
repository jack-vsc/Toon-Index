import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  /** The page (index into `pages`) to open at: where the chapter was left. */
  startPage?: number
  /** The page in view and how far into the chapter the reader is (0 to 1), as they change. */
  onPage?: (index: number, progress: number) => void
  /** Shown after the last page: what to read next. */
  footer?: ReactNode
}

export function Reader({ pages, mode, zoom, onEnd, startPage = 0, onPage, footer }: Props) {
  const ended = useRef(false)
  const end = () => {
    if (ended.current) return
    ended.current = true
    onEnd?.()
  }
  return mode === 'paged' ? (
    <PagedReader pages={pages} zoom={zoom} onEnd={end} startPage={startPage} onPage={onPage} footer={footer} />
  ) : (
    <ScrollReader pages={pages} zoom={zoom} onEnd={end} startPage={startPage} onPage={onPage} footer={footer} />
  )
}

interface ModeProps {
  pages: ReaderPage[]
  zoom: number
  onEnd: () => void
  startPage: number
  onPage?: (index: number, progress: number) => void
  footer?: ReactNode
}

function ScrollReader({ pages, zoom, onEnd, startPage, onPage, footer }: ModeProps) {
  const root = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const started = useRef(false)
  const shown = useRef(-1)

  useEffect(() => {
    if (!bottom.current) return
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && onEnd())
    observer.observe(bottom.current)
    return () => observer.disconnect()
  }, [onEnd])

  // Back to where the chapter was left, once its pages are laid out (they keep their size while loading).
  useEffect(() => {
    if (started.current || !pages.length || !root.current) return
    started.current = true
    if (startPage > 0) root.current.querySelector(`[data-page="${Math.min(startPage, pages.length - 1)}"]`)?.scrollIntoView({ block: 'start' })
  }, [pages.length, startPage])

  useEffect(() => {
    const scroller = root.current?.closest('.content')
    if (!scroller || !onPage) return
    const onScroll = () => {
      const view = scroller.getBoundingClientRect()
      const middle = view.top + view.height / 2
      let index = 0
      root.current?.querySelectorAll<HTMLElement>('[data-page]').forEach((el, i) => {
        if (el.getBoundingClientRect().top <= middle) index = i
      })
      const box = root.current!.getBoundingClientRect()
      const progress = Math.min(1, Math.max(0, (view.bottom - box.top) / Math.max(1, box.height)))
      if (index === shown.current) return
      shown.current = index
      onPage(index, progress)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [onPage, pages.length])

  return (
    <div className="reader" ref={root}>
      {pages.map((page, i) => (
        <PageView key={page.key} index={i} page={page} width={`${zoom}%`} className={page.tall ? 'tall' : ''} />
      ))}
      <div ref={bottom} />
      {footer}
    </div>
  )
}

function PagedReader({ pages, zoom, onEnd, startPage, onPage, footer }: ModeProps) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(startPage, pages.length - 1)))
  const scroller = useRef<HTMLDivElement>(null)
  const current = pages[Math.min(index, pages.length - 1)]
  const last = index >= pages.length - 1

  useEffect(() => {
    if (pages.length > 1 && last) onEnd()
    if (pages.length) onPage?.(index, pages.length > 1 ? index / (pages.length - 1) : 1)
  }, [index, pages.length])

  const go = (delta: number) => setIndex((i) => Math.min(pages.length - 1, Math.max(0, i + delta)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') go(1)
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
        <div className="paged-column">
          <PageView index={index} page={current} width={current.tall ? `${zoom}%` : undefined} className={current.tall ? 'tall' : 'fit'} />
          {last && footer}
        </div>
        <button className="paged-zone right" aria-label="Próxima página" onClick={() => go(1)} disabled={last} />
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
        <button className="secondary" onClick={() => go(1)} disabled={last}>
          Próxima ›
        </button>
      </div>
    </div>
  )
}

function PageView({ page, index, width, className }: { page: ReaderPage; index: number; width?: string; className: string }) {
  // The page keeps its size while its image loads, so the pages below do not move.
  const size = { width, aspectRatio: `1 / ${page.aspect}` }
  if (page.url) return <img data-page={index} src={page.url} alt={`Página ${page.number}`} className={className} style={className === 'fit' ? { width } : size} />
  return (
    <div data-page={index} className={`reader-placeholder ${className}`} style={size}>
      <span className="spinner" />
      <span>
        Página {page.number}
        {page.status ? ` · ${page.status}` : ''}
      </span>
    </div>
  )
}
