import { PDFDocument } from 'pdf-lib'

export interface OutputPage {
  jpeg: Uint8Array
  widthPt: number
  heightPt: number
}

export async function buildPdf(pages: OutputPage[], title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setCreator('Toon Index')
  for (const page of pages) {
    const image = await pdf.embedJpg(page.jpeg)
    const target = pdf.addPage([page.widthPt, page.heightPt])
    target.drawImage(image, { x: 0, y: 0, width: page.widthPt, height: page.heightPt })
  }
  return pdf.save()
}
