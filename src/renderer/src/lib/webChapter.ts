import type { WebChapter } from '../../../shared/types'
import { buildPdf, type OutputPage } from './exportPdf'
import { canvasToBlob } from './pdf'

/**
 * Packs a chapter downloaded from a link into a PDF, one page per image at its pixel size, so it goes
 * through the same steps as a PDF the person opens. JPEG pages are kept as they are; other formats
 * (WebP, PNG, AVIF) are decoded by the browser and stored as JPEG.
 */
export async function webChapterToPdf(chapter: WebChapter): Promise<Uint8Array> {
  const pages: OutputPage[] = []
  for (const [i, bytes] of chapter.images.entries()) {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart])).catch(() => {
      throw new Error(`A página ${i + 1} do capítulo veio do site sem uma imagem que dê para abrir. Tente de novo.`)
    })
    const { width, height } = bitmap
    let jpeg = bytes
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
      jpeg = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer())
    }
    bitmap.close()
    pages.push({ jpeg, widthPt: width, heightPt: height })
  }
  return buildPdf(pages, chapter.title)
}
