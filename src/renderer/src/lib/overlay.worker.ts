/// <reference lib="webworker" />
import type { TextBlock } from '../../../shared/types'
import { drawOverlay } from './overlay'
import type { Scene } from './scene'

import bangers400 from '@fontsource/bangers/files/bangers-latin-400-normal.woff2?url'
import comic300 from '@fontsource/comic-neue/files/comic-neue-latin-300-normal.woff2?url'
import comic400 from '@fontsource/comic-neue/files/comic-neue-latin-400-normal.woff2?url'
import comic700 from '@fontsource/comic-neue/files/comic-neue-latin-700-normal.woff2?url'
import kalam400 from '@fontsource/kalam/files/kalam-latin-400-normal.woff2?url'
import kalam700 from '@fontsource/kalam/files/kalam-latin-700-normal.woff2?url'
import serif400 from '@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2?url'
import serif700 from '@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff2?url'
import oswald200 from '@fontsource/oswald/files/oswald-latin-200-normal.woff2?url'
import oswald300 from '@fontsource/oswald/files/oswald-latin-300-normal.woff2?url'
import oswald400 from '@fontsource/oswald/files/oswald-latin-400-normal.woff2?url'
import oswald500 from '@fontsource/oswald/files/oswald-latin-500-normal.woff2?url'
import oswald600 from '@fontsource/oswald/files/oswald-latin-600-normal.woff2?url'
import roboto400 from '@fontsource/roboto/files/roboto-latin-400-normal.woff2?url'
import roboto700 from '@fontsource/roboto/files/roboto-latin-700-normal.woff2?url'

/**
 * Erases the lettering and writes the translation on a page, away from the window (overlayWorkers.ts):
 * measuring the glyphs and typesetting are seconds of work per page. The fonts the window gets from CSS
 * (fonts.ts) are loaded here from their files; the inpainting model is reached through the window.
 */
const FILES: [string, number, string][] = [
  ['Bangers', 400, bangers400],
  ['Comic Neue', 300, comic300],
  ['Comic Neue', 400, comic400],
  ['Comic Neue', 700, comic700],
  ['Kalam', 400, kalam400],
  ['Kalam', 700, kalam700],
  ['Noto Serif', 400, serif400],
  ['Noto Serif', 700, serif700],
  ['Oswald', 200, oswald200],
  ['Oswald', 300, oswald300],
  ['Oswald', 400, oswald400],
  ['Oswald', 500, oswald500],
  ['Oswald', 600, oswald600],
  ['Roboto', 400, roboto400],
  ['Roboto', 700, roboto700]
]

let fonts: Promise<void> | null = null
function loadFonts(): Promise<void> {
  fonts ??= Promise.all(
    FILES.map(async ([family, weight, url]) => {
      self.fonts.add(await new FontFace(family, `url(${url})`, { weight: String(weight) }).load())
    })
  ).then(() => undefined)
  return fonts
}

const inpaints = new Map<number, (bitmap: ImageBitmap | null) => void>()
let nextInpaint = 0

/** Asks the window to run the inpainting model on the canvas, and paints its result in. */
async function inpaint(canvas: OffscreenCanvas, mask: Uint8Array): Promise<boolean> {
  const at = nextInpaint++
  const image = await createImageBitmap(canvas)
  const done = new Promise<ImageBitmap | null>((resolve) => inpaints.set(at, resolve))
  self.postMessage({ request: 'inpaint', at, image, mask }, [image, mask.buffer])
  const out = await done
  if (!out) return false
  canvas.getContext('2d')!.drawImage(out, 0, 0)
  out.close()
  return true
}

interface DrawJob {
  id: number
  page: ImageBitmap
  blocks: TextBlock[]
  scene: Scene | null
}

self.onmessage = async (e: MessageEvent<DrawJob | { inpainted: number; bitmap: ImageBitmap | null }>) => {
  const msg = e.data
  if ('inpainted' in msg) {
    inpaints.get(msg.inpainted)?.(msg.bitmap)
    inpaints.delete(msg.inpainted)
    return
  }
  const { id, page, blocks, scene } = msg
  try {
    await loadFonts()
    const canvas = new OffscreenCanvas(page.width, page.height)
    canvas.getContext('2d', { willReadFrequently: true })!.drawImage(page, 0, 0)
    page.close()
    const infos = await drawOverlay(canvas, blocks, scene, (c, mask) => inpaint(c as OffscreenCanvas, mask))
    const result = canvas.transferToImageBitmap()
    self.postMessage({ id, result: { page: result, infos } }, [result])
  } catch (err) {
    self.postMessage({ id, error: String((err as Error).message ?? err) })
  }
}
