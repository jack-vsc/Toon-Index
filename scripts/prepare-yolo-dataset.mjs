#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { createCanvas, loadImage } from 'canvas'

const EVAL_DIR = process.argv[2] || path.resolve(process.cwd(), 'samples', 'eval', 'v22')
const OUT_DIR = process.argv[3] || path.resolve(process.cwd(), 'models', 'yolo_dataset')

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

ensure(OUT_DIR)
ensure(path.join(OUT_DIR, 'images'))
ensure(path.join(OUT_DIR, 'labels'))

const files = fs.readdirSync(EVAL_DIR).filter((f) => f.match(/^p\d+\.json$/i))
if (!files.length) {
  console.error('No pNN.json files found in', EVAL_DIR)
  process.exit(1)
}

const filesSorted = files.sort()
let imgCount = 0
for (const jf of filesSorted) {
  const m = jf.match(/p(\d+)\.json/i)
  if (!m) continue
  const pad = m[1].padStart(2, '0')
  const jsonPath = path.join(EVAL_DIR, jf)
  const beforePng = path.join(EVAL_DIR, `p${pad}-before.png`)
  if (!fs.existsSync(beforePng)) {
    console.warn('Missing before image for', jf, '- skipping')
    continue
  }
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  const blocks = raw.blocks ?? []
  const imgName = `page-${pad}.png`
  const outImg = path.join(OUT_DIR, 'images', imgName)
  fs.copyFileSync(beforePng, outImg)
  const labelLines = []
  try {
    const im = await loadImage(beforePng)
    const W = im.width
    const H = im.height
    for (const b of blocks) {
      const box = b.textBox
      if (!box || box.length !== 4) continue
      const [x0, y0, x1, y1] = box
      const cx = (x0 + x1) / 2 / W
      const cy = (y0 + y1) / 2 / H
      const w = (x1 - x0) / W
      const h = (y1 - y0) / H
      if (w <= 0 || h <= 0) continue
      labelLines.push(`0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`)
    }
    fs.writeFileSync(path.join(OUT_DIR, 'labels', `page-${pad}.txt`), labelLines.join('\n'))
    imgCount++
  } catch (err) {
    console.warn('Failed processing', beforePng, err.message)
  }
}
console.log(`Prepared YOLO dataset in ${OUT_DIR} with ${imgCount} images`)

