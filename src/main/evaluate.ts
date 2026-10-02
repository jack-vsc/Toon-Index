import { app, ipcMain } from 'electron'
import { readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { EvalConfig } from '../shared/types'

/**
 * Developer evaluation run: MI_EVAL_PDF (sample chapter), MI_EVAL_REF (folder with the same chapter
 * translated by hand), MI_EVAL_OUT (where comparison sheets go), MI_EVAL_PAGES ("2-4,7") and
 * MI_EVAL_DETECT=1 (only mark the detected text, no model calls).
 */
function evalConfig(): EvalConfig | null {
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
  const readable = new Set([config.pdf, ...config.reference])
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
