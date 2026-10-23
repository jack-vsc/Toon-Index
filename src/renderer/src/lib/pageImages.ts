import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'

export interface PdfPageImage {
  widthPt: number
  heightPt: number
  /** The JPEG the page is made of, when it is one JPEG and nothing else (as the app's PDFs are). */
  jpeg: Uint8Array | null
}

/**
 * The pages of a PDF with the JPEG each is made of, read without drawing anything: the app's chapters
 * are one picture per page, and showing that picture as it is takes no time, where drawing a long
 * webtoon strip and encoding it again takes seconds.
 */
export async function pdfPageImages(bytes: Uint8Array): Promise<PdfPageImage[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  const IMAGE = PDFName.of('Image')
  const DCT = PDFName.of('DCTDecode')
  return doc.getPages().map((page) => {
    const { width, height } = page.getSize()
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    const images = (xobjects?.values() ?? [])
      .map((ref) => doc.context.lookup(ref))
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === IMAGE)
    const only = images.length === 1 ? images[0] : null
    // A mask or another filter would need pdf.js to be shown right.
    const jpeg = only && only.dict.get(PDFName.of('Filter')) === DCT && !only.dict.has(PDFName.of('SMask')) ? only.contents : null
    return { widthPt: width, heightPt: height, jpeg }
  })
}
