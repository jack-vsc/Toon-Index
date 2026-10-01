import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'pdfjs-dist')
const target = join(root, 'src', 'renderer', 'public', 'pdfjs')

mkdirSync(target, { recursive: true })
for (const dir of ['wasm', 'cmaps', 'standard_fonts', 'iccs']) {
  const from = join(source, dir)
  if (existsSync(from)) cpSync(from, join(target, dir), { recursive: true })
}
