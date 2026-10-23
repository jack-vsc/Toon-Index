import { useEffect, useRef, useState } from 'react'
import type { ReaderPage } from '../components/Reader'
import { pdfPageImages, type PdfPageImage } from './pageImages'
import { canvasToBlob, isTallPage, loadPdf, pageSize, renderPage } from './pdf'

const READER_WIDTH = 1100

/**
 * The pages of a PDF as image URLs; pages not ready yet come without `url`. Pages that are one JPEG
 * (the app's own chapters) are shown as they are, at once; the others are drawn one by one, from
 * `firstPage` (an index: where the chapter was left) on, then the ones before it.
 */
export function usePdfPages(data: Uint8Array | null, firstPage = 0): ReaderPage[] {
  const [pages, setPages] = useState<ReaderPage[]>([])
  // Read when a PDF opens, not followed after (it changes as the reader scrolls).
  const first = useRef(firstPage)
  first.current = firstPage

  useEffect(() => {
    setPages([])
    if (!data) return
    let cancelled = false
    const urls: string[] = []
    const show = (number: number, url: string) => {
      urls.push(url)
      if (!cancelled) setPages((list) => list.map((p) => (p.number === number ? { ...p, url } : p)))
    }

    ;(async () => {
      const images: PdfPageImage[] | null = await pdfPageImages(data).catch(() => null)
      if (cancelled) return
      if (images) {
        setPages(
          images.map(({ widthPt, heightPt, jpeg }, i) => {
            const url = jpeg ? URL.createObjectURL(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })) : undefined
            if (url) urls.push(url)
            return { key: `p${i + 1}`, number: i + 1, aspect: heightPt / widthPt, tall: isTallPage(widthPt, heightPt), url }
          })
        )
        if (images.every((p) => p.jpeg)) return
      }
      const doc = await loadPdf(data)
      try {
        if (!images) {
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
        }
        const start = Math.min(Math.max(1, first.current + 1), doc.numPages)
        const order = [
          ...Array.from({ length: doc.numPages - start + 1 }, (_, k) => start + k),
          ...Array.from({ length: start - 1 }, (_, k) => start - 1 - k)
        ]
        for (const i of order) {
          if (cancelled) break
          if (images?.[i - 1]?.jpeg) continue
          const { canvas } = await renderPage(doc, i, READER_WIDTH)
          show(i, URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.92)))
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
