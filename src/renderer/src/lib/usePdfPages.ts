import { useEffect, useState } from 'react'
import type { ReaderPage } from '../components/Reader'
import { canvasToBlob, isTallPage, loadPdf, pageSize, renderPage } from './pdf'

const READER_WIDTH = 1100

/** Renders the pages of a PDF one by one into image URLs; pages not rendered yet come without `url`. */
export function usePdfPages(data: Uint8Array | null): ReaderPage[] {
  const [pages, setPages] = useState<ReaderPage[]>([])

  useEffect(() => {
    setPages([])
    if (!data) return
    let cancelled = false
    const urls: string[] = []

    ;(async () => {
      const doc = await loadPdf(data)
      try {
        const sizes = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => pageSize(doc, i + 1)))
        if (cancelled) return
        setPages(
          sizes.map(({ widthPt, heightPt }, i) => ({
            key: `p${i + 1}`,
            number: i + 1,
            aspect: heightPt / widthPt,
            tall: isTallPage(widthPt, heightPt)
          }))
        )
        for (let i = 1; i <= doc.numPages && !cancelled; i++) {
          const { canvas } = await renderPage(doc, i, READER_WIDTH)
          const url = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.92))
          urls.push(url)
          if (!cancelled) setPages((list) => list.map((p) => (p.number === i ? { ...p, url } : p)))
        }
      } finally {
        await doc.loadingTask.destroy()
      }
    })()

    return () => {
      cancelled = true
      urls.forEach(URL.revokeObjectURL)
    }
  }, [data])

  return pages
}
