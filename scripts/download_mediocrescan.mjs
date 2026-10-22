#!/usr/bin/env node
/**
 * Download MediocreToons chapter images (CDN manifest).
 * Token: env MEDIocreSCAN_TOKEN or --token (never commit tokens).
 *
 * Usage:
 *   node scripts/download_mediocrescan.mjs 570564 569104
 *   (page-001 = primeira página de leitura; use --order desc só se quiser o inverso)
 *   $env:MEDIocreSCAN_TOKEN="..." ; node scripts/download_mediocrescan.mjs 570564
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://back2.mediocrescan.com'
const CDN = 'https://cdn.mediocrescan.com'

function parseArgs() {
  const argv = process.argv.slice(2)
  let token = process.env.MEDIocreSCAN_TOKEN || ''
  let order = 'asc'
  const ids = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--token') token = argv[++i] ?? ''
    else if (argv[i] === '--order') order = argv[++i] ?? 'asc'
    else if (/^\d+$/.test(argv[i])) ids.push(Number(argv[i]))
  }
  if (!token) {
    console.error('Defina MEDIocreSCAN_TOKEN ou passe --token')
    process.exit(1)
  }
  if (!ids.length) {
    console.error('Passe um ou mais IDs de capítulo (ex.: 570564)')
    process.exit(1)
  }
  return { token, order, ids }
}

function safeDirName(name) {
  return String(name ?? 'sem-nome')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'sem-nome'
}

function capNumFolder(e) {
  const t = typeof e === 'number' ? e : parseFloat(String(e).replace(',', '.'))
  return String(Number.isFinite(t) && Number.isInteger(t) ? Math.trunc(t) : e)
}

async function apiGet(token, chapterId) {
  const res = await fetch(`${API}/capitulos/${chapterId}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Mozilla/5.0' }
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`capitulos/${chapterId} HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

function manifestUrl(meta) {
  const obrId = meta?.obra?.id ?? meta?.obra?.obr_id
  const uuid = meta?.cap_uuid ?? meta?.uuid
  const num = capNumFolder(meta?.cap_num ?? meta?.numero)
  if (obrId == null || !uuid || num == null) return null
  return `${CDN}/obras/${obrId}/capitulos/${num}/${uuid}.json`
}

async function downloadChapter({ token, chapterId, order, outRoot }) {
  const meta = await apiGet(token, chapterId)
  const obraName = meta?.obra?.obr_nome ?? meta?.obra?.nome ?? `obra-${meta?.obr_id ?? 'x'}`
  const capLabel = safeDirName(`cap-${capNumFolder(meta?.cap_num)}-${chapterId}`)
  const dir = path.join(outRoot, safeDirName(obraName), capLabel)
  fs.mkdirSync(dir, { recursive: true })

  const manifestUrlStr = manifestUrl(meta)
  if (!manifestUrlStr) throw new Error(`cap ${chapterId}: não foi possível montar URL do manifest`)

  const manRes = await fetch(manifestUrlStr, { cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!manRes.ok) throw new Error(`manifest ${manifestUrlStr} HTTP ${manRes.status}`)
  let pages = await manRes.json()
  if (!Array.isArray(pages) || pages.length === 0) throw new Error(`cap ${chapterId}: manifest vazio`)

  pages = [...pages].sort((a, b) => Number(a.ordem) - Number(b.ordem))
  if (order === 'desc') pages.reverse()

  let n = 0
  for (const p of pages) {
    n++
    const rel = String(p.url ?? p.src ?? '').trim()
    if (!rel) continue
    const imgUrl = rel.startsWith('http') ? rel : `${CDN}/${rel.replace(/^\/+/, '')}`
    const ext = path.extname(rel.split('?')[0]) || '.webp'
    const outFile = path.join(dir, `page-${String(n).padStart(3, '0')}${ext}`)
    const imgRes = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!imgRes.ok) throw new Error(`página ${n} HTTP ${imgRes.status}`)
    const buf = Buffer.from(await imgRes.arrayBuffer())
    fs.writeFileSync(outFile, buf)
  }

  const metaPath = path.join(dir, 'chapter-meta.json')
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  const orderPath = path.join(dir, 'pages-order.json')
  fs.writeFileSync(
    orderPath,
    JSON.stringify(
      {
        pageNumbering: order === 'desc' ? 'mediocre-desc' : 'reading-asc',
        downloadOrder: order,
        pageCount: n
      },
      null,
      2
    )
  )
  console.log(`OK ${chapterId}: ${n} páginas -> ${dir}`)
  return { dir, pages: n, obraName }
}

async function main() {
  const { token, order, ids } = parseArgs()
  const outRoot = path.join(root, 'samples')
  fs.mkdirSync(outRoot, { recursive: true })

  for (const id of ids) {
    try {
      await downloadChapter({ token, chapterId: id, order, outRoot })
    } catch (err) {
      console.error(`ERRO ${id}:`, err.message ?? err)
      process.exitCode = 1
    }
  }
}

main()
