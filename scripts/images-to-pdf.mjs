// Packs a folder of page images (jpg/png) into a PDF, one page per image at its pixel size.
// Usage: node scripts/images-to-pdf.mjs <folder> <out.pdf>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'

const [dir, out] = process.argv.slice(2)
if (!dir || !out) throw new Error('usage: images-to-pdf <folder> <out.pdf>')
const pdf = await PDFDocument.create()
for (const name of readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort()) {
  const bytes = readFileSync(join(dir, name))
  const image = /\.png$/i.test(name) ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)
  pdf.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
}
writeFileSync(out, await pdf.save())
console.log(`${pdf.getPageCount()} pages -> ${out}`)
