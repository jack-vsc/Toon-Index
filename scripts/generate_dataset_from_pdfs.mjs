/**
 * Build YOLO dataset from two PDFs (original + translated) via pixel-difference auto-labeling.
 * Usage:
 *   node scripts/generate_dataset_from_pdfs.mjs --orig "samples/[EN]....pdf" --trans "samples/[PTBR]....pdf"
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'child_process'

function parseArgs() {
  const args = process.argv.slice(2)
  let orig = null
  let trans = null
  let out = path.resolve('models/yolo_dataset')
  let ptPerEn = 8
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--orig' || args[i] === '-o') orig = args[++i]
    else if (args[i] === '--trans' || args[i] === '-t') trans = args[++i]
    else if (args[i] === '--out') out = path.resolve(args[++i])
    else if (args[i] === '--pt-per-en') ptPerEn = parseInt(args[++i], 10) || 8
  }
  if (!orig || !trans) {
    console.error('Usage: node scripts/generate_dataset_from_pdfs.mjs --orig <en.pdf> --trans <ptbr.pdf> [--out models/yolo_dataset]')
    process.exit(1)
  }
  orig = path.resolve(orig)
  trans = path.resolve(trans)
  if (!fs.existsSync(orig)) {
    console.error('Original PDF not found:', orig)
    process.exit(1)
  }
  if (!fs.existsSync(trans)) {
    console.error('Translated PDF not found:', trans)
    process.exit(1)
  }
  return { orig, trans, out, ptPerEn }
}

async function renderPdfPages(pdfPath, outDir) {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const standardFontDataUrl = `${pathToFileURL(path.resolve('node_modules/pdfjs-dist/standard_fonts')).href}/`
  const pdfDoc = await pdfjs.getDocument({ data, standardFontDataUrl }).promise
  console.log(`Rendering ${pdfDoc.numPages} pages from ${path.basename(pdfPath)}...`)

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum)
    const viewport = page.getViewport({ scale: 2.0 })
    const canvas = createCanvas(viewport.width, viewport.height)
    const context = canvas.getContext('2d')
    await page.render({ canvasContext: context, viewport }).promise
    const pageName = `page-${String(pageNum).padStart(3, '0')}.png`
    fs.writeFileSync(path.join(outDir, pageName), await canvas.encode('png'))
    process.stdout.write('.')
  }
  console.log(`\nSaved to ${outDir}`)
}

async function runPythonAutoLabel(origDir, transDir, outputDatasetDir, ptPerEn) {
  const pythonBin = path.join('.venv', 'Scripts', 'python.exe')
  const pythonExe = fs.existsSync(pythonBin) ? pythonBin : 'python'
  const args = [
    'scripts/auto_label_difference.py',
    '--orig', origDir,
    '--trans', transDir,
    '--out', outputDatasetDir,
    '--min-area', '150',
    '--max-pct', '0.4',
    '--dilate', '10',
    '--pt-per-en', String(ptPerEn)
  ]
  console.log(`\nAuto-labeling: ${pythonExe} ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, args, { stdio: 'inherit', cwd: process.cwd() })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
  })
}

async function main() {
  const { orig, trans, out, ptPerEn } = parseArgs()
  console.log(`Alignment: ${ptPerEn} página(s) PT-BR por página EN (conteúdo); capa 1:1`)
  const tempOrig = path.resolve('temp_orig_dataset_images')
  const tempTrans = path.resolve('temp_trans_dataset_images')

  console.log('\n[1/3] Original (EN):', orig)
  await renderPdfPages(orig, tempOrig)

  console.log('\n[2/3] Translated (PT-BR):', trans)
  await renderPdfPages(trans, tempTrans)

  console.log('\n[3/3] YOLO dataset ->', out)
  for (const sub of ['images', 'labels']) {
    const d = path.join(out, sub)
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d, { recursive: true })
  }
  await runPythonAutoLabel(tempOrig, tempTrans, out, ptPerEn)

  fs.rmSync(tempOrig, { recursive: true, force: true })
  fs.rmSync(tempTrans, { recursive: true, force: true })

  const imgCount = fs.existsSync(path.join(out, 'images'))
    ? fs.readdirSync(path.join(out, 'images')).filter((f) => /\.(png|jpe?g)$/i.test(f)).length
    : 0
  const lblCount = fs.existsSync(path.join(out, 'labels'))
    ? fs.readdirSync(path.join(out, 'labels')).filter((f) => f.endsWith('.txt')).length
    : 0
  console.log('\nDone:', imgCount, 'images,', lblCount, 'label files in', out)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
