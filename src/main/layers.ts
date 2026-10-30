import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Translated pages kept as only what the translation changed on them (renderer/lib/layers), one small
 * file a page named by the page's key: a chapter deleted and translated again is put back from these.
 */

export const layersDir = (): string => join(app.getPath('userData'), 'translation-layers')

const fileOf = (key: string): string | null => (/^[a-f0-9]{64}$/.test(key) ? join(layersDir(), `${key}.json`) : null)

export function readLayer(key: string): string | null {
  const file = fileOf(key)
  return file && existsSync(file) ? readFileSync(file, 'utf8') : null
}

export function saveLayer(key: string, layer: string): void {
  const file = fileOf(key)
  if (!file) return
  mkdirSync(layersDir(), { recursive: true })
  writeFileSync(file, layer)
}

export function clearLayers(): void {
  rmSync(layersDir(), { recursive: true, force: true })
}
