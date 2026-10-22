#!/usr/bin/env node
/**
 * Download chapter images from mgread.io (HTML scrape).
 * Usage:
 *   node scripts/download_mgread.mjs the-mythical-weapon-creation-of-the-regressed-genius-player 43 44 53
 *   node scripts/download_mgread.mjs <slug> --from 43 --to 53 --title "Manga Name"
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = 'https://mgread.io'

function parseArgs() {
  const argv = process.argv.slice(2)
  let from = null
  let to = null
  let title = null
  const slugParts = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') from = Number(argv[++i])
    else if (argv[i] === '--to') to = Number(argv[++i])
    else if (argv[i] === '--title') title = argv[++i]
    else if (!argv[i].startsWith('--')) slugParts.push(argv[i])
  }
  const slug = slugParts[0]
  const chapters = slugParts.slice(1).map(Number).filter((n) => Number.isFinite(n))
  let list = chapters
  if (from != null && to != null) {
    list = []
    for (let c = from; c <= to; c++) list.push(c)
  }
  if (!slug || !list.length) {
    console.error('Uso: node scripts/download_mgread.mjs <slug> 43 44 ... | --from 43 --to 53 [--title Nome]')
    process.exit(1)
  }
  return { slug, chapters: list, title }
}

function safeDirName(name) {
  return String(name ?? 'manga')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

function slugToTitle(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

async function fetchChapterPageUrls(slug, chapter) {
  const pageUrl = `${SITE}/manga/${slug}/chapter-${chapter}/`
  const res = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`${pageUrl} HTTP ${res.status}`)
  const html = await res.text()
  const re = new RegExp(`https://mg\\.mgread\\.io/\\d+/${chapter}/\\d+\\.(?:jpg|jpeg|webp|png)`, 'gi')
  const found = [...html.matchAll(re)].map((m) => m[0])
  const byPage = new Map()
  for (const url of found) {
    const m = url.match(/\/(\d+)\.(jpg|jpeg|webp|png)$/i)
    if (!m) continue
    byPage.set(Number(m[1]), url)
  }
  return [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([, url]) => url)
}

async function downloadChapter({ slug, chapter, outDir }) {
  const urls = await fetchChapterPageUrls(slug, chapter)
  if (!urls.length) throw new Error(`cap ${chapter}: nenhuma imagem encontrada`)
  const dir = path.join(outDir, `cap-${chapter}`)
  fs.mkdirSync(dir, { recursive: true })
  let n = 0
  for (const imgUrl of urls) {
    n++
    const ext = path.extname(imgUrl.split('?')[0]) || '.jpg'
    const outFile = path.join(dir, `page-${String(n).padStart(3, '0')}${ext}`)
    const res = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${SITE}/` } })
    if (!res.ok) throw new Error(`página ${n} HTTP ${res.status}`)
    fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()))
  }
  fs.writeFileSync(
    path.join(dir, 'source.json'),
    JSON.stringify({ site: SITE, slug, chapter, pages: urls.length, urls }, null, 2)
  )
  console.log(`OK cap ${chapter}: ${n} páginas -> ${dir}`)
}

async function main() {
  const { slug, chapters, title } = parseArgs()
  const mangaTitle = title ?? slugToTitle(slug)
  const outDir = path.join(root, 'samples', safeDirName(mangaTitle))
  fs.mkdirSync(outDir, { recursive: true })
  for (const ch of chapters) {
    try {
      await downloadChapter({ slug, chapter: ch, outDir })
    } catch (err) {
      console.error(`ERRO cap ${ch}:`, err.message ?? err)
      process.exitCode = 1
    }
  }
}

main()
