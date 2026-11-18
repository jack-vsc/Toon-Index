import { app, ipcMain } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { EvalConfig } from '../shared/types'
import { markReplayed, replayedChapters, TEACHER } from './translate/dataset'

/**
 * Developer evaluation run: MI_EVAL_PDF (sample chapter), MI_EVAL_REF (folder with the same chapter
 * translated by hand), MI_EVAL_OUT (where comparison sheets go), MI_EVAL_PAGES ("2-4,7") and
 * MI_EVAL_DETECT=1 (only mark the detected text, no model calls), MI_EVAL_SFX=1 (translate sound
 * effects whatever the saved settings say) and MI_EVAL_MODEL="<base url>|<model>" (translate with
 * another OpenAI-compatible model, e.g. a local Ollama one; "local|gemma-4-e4b" is the app's own).
 */
function evalConfig(): EvalConfig | null {
  if (process.env.MI_REPLAY_LIBRARY) return replayConfig(process.env.MI_REPLAY_LIBRARY)
  const pdf = process.env.MI_EVAL_PDF
  if (!pdf) return null
  const refDir = process.env.MI_EVAL_REF
  const reference = refDir
    ? readdirSync(refDir)
        .filter((f) => /\.(webp|png|jpe?g)$/i.test(f))
        .sort()
        .map((f) => resolve(refDir, f))
    : []
  return { pdf: resolve(pdf), reference, pages: parsePages(process.env.MI_EVAL_PAGES), detectOnly: process.env.MI_EVAL_DETECT === '1' }
}

/**
 * MI_REPLAY_LIBRARY=<library folder> (with MI_CACHE_ONLY=1): every chapter translated before is read
 * again, so the answers kept in the translation cache go into the training dataset without asking any
 * model. One work after another in turn, so stopping early still leaves a varied dataset; chapters
 * done in an earlier run are skipped.
 */
function replayConfig(library: string): EvalConfig {
  const done = replayedChapters()
  // The dataset teaches balloons: novels' works are left out (renderer lib/replay also skips text PDFs).
  const novels = new Set<string>()
  try {
    const { works } = JSON.parse(readFileSync(join(library, 'works.json'), 'utf8'))
    for (const w of works ?? []) if (w.format === 'novel') novels.add(w.id)
  } catch {
    // No works yet.
  }
  const byWork = new Map<string, { id: string; pdf: string; title: string; chapter: number }[]>()
  for (const id of readdirSync(library)) {
    const pdf = join(library, id, 'original.pdf')
    if (done.has(id) || !existsSync(pdf)) continue
    try {
      const meta = JSON.parse(readFileSync(join(library, id, 'meta.json'), 'utf8'))
      if (!TEACHER.test(meta.model ?? '') || meta.novel || novels.has(meta.workId)) continue
      const list = byWork.get(meta.workId ?? id) ?? []
      list.push({ id, pdf, title: meta.title ?? id, chapter: meta.chapter ?? 0 })
      byWork.set(meta.workId ?? id, list)
    } catch {
      // No readable meta: not a chapter.
    }
  }
  const works = [...byWork.values()].map((list) => list.sort((a, b) => a.chapter - b.chapter))
  const replay: EvalConfig['replay'] = []
  for (let i = 0; works.some((w) => i < w.length); i++) {
    for (const w of works) if (i < w.length) replay.push({ id: w[i].id, pdf: w[i].pdf, title: w[i].title })
  }
  return { pdf: '', reference: [], pages: null, detectOnly: false, replay, replayPages: Number(process.env.MI_REPLAY_PAGES) || 0 }
}

function parsePages(spec: string | undefined): number[] | null {
  if (!spec?.trim()) return null
  return spec.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map(Number)
    return Array.from({ length: (b || a) - a + 1 }, (_, i) => a + i)
  })
}

export function registerEvalIpc(): void {
  const config = evalConfig()
  ipcMain.handle('eval:config', () => config)
  if (!config) return
  const out = resolve(process.env.MI_EVAL_OUT ?? 'eval-out')
  const readable = new Set([config.pdf, ...config.reference, ...(config.replay ?? []).map((c) => c.pdf)])
  ipcMain.handle('eval:replayed', (_e, id: string) => markReplayed(id))
  ipcMain.handle('eval:read', (_e, path: string) => {
    if (!readable.has(path)) throw new Error(`Not an evaluation file: ${path}`)
    return readFile(path)
  })
  ipcMain.handle('eval:write', async (_e, name: string, data: Uint8Array | string) => {
    await mkdir(out, { recursive: true })
    await writeFile(join(out, basename(name)), data)
  })
  ipcMain.handle('eval:log', (_e, message: string) => console.log(`[eval] ${message}`))
  ipcMain.handle('eval:done', () => app.quit())
}
