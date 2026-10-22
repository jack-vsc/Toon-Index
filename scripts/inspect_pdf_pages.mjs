import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'node:url'

async function sizes(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const standardFontDataUrl = `${pathToFileURL(path.resolve('node_modules/pdfjs-dist/standard_fonts')).href}/`
  const doc = await pdfjs.getDocument({ data, standardFontDataUrl }).promise
  const out = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const v = page.getViewport({ scale: 1 })
    out.push({ page: i, w: Math.round(v.width), h: Math.round(v.height) })
  }
  return out
}

const en = path.resolve('samples/[EN] [053]The Mythical Weapon Creation.pdf')
const pt = path.resolve('samples/[PTBR] [053]The Mythical Weapon Creation o [@Extreme_Manhwa].pdf')
console.log('EN', (await sizes(en)).length, 'pages')
console.log((await sizes(en)).slice(0, 5))
console.log('PT', (await sizes(pt)).length, 'pages')
console.log((await sizes(pt)).slice(0, 12))
