import { app, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PageImage, TranslateRequest } from '../../shared/types'

/**
 * Every page the AI translates is kept as a training example for a smaller model (Manga Detector
 * Pipeline), laid out like Manga109: the images once each, the annotations one file a chapter.
 *
 *   training-dataset/images/<hash>.jpg          each image sent to the model, stored once (shrunk)
 *   training-dataset/annotations/<chapter>.jsonl one line a request: the images it was given (page slices,
 *                                                then the tagged key), the marked regions, the prompt and
 *                                                the model's raw answer
 *   training-dataset/recorded.txt                cache keys already kept, so a page translated again
 *                                                (or put back from the cache) is not kept twice
 * MI_DATASET_DIR moves it; MI_DATASET=0 turns it off.
 */

export interface Example {
  /** The translation cache key: same images, prompt and model. */
  key: string
  req: TranslateRequest
  kind: 'page' | 'followup'
  prompt: string
  images: PageImage[]
  answer: string
  model: string
  speed: string
}

/** Only answers from these models teach the small one (Claude, directly or through OpenRouter). */
export const TEACHER = /claude/i
const STORED_SIDE = 768
const STORED_QUALITY = 75

let recorded: Set<string> | null = null

export const datasetDir = (): string => process.env.MI_DATASET_DIR || join(app.getPath('userData'), 'training-dataset')
const root = datasetDir

/** Library chapters already read again from the cache (main/evaluate, MI_REPLAY_LIBRARY). */
export function replayedChapters(): Set<string> {
  const file = join(root(), 'replayed.txt')
  return new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
}

export function markReplayed(id: string): void {
  mkdirSync(root(), { recursive: true })
  appendFileSync(join(root(), 'replayed.txt'), id + '\n')
}

function recordedKeys(): Set<string> {
  if (!recorded) {
    const file = join(root(), 'recorded.txt')
    recorded = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
  }
  return recorded
}

/**
 * Writes the image once, named by its content, shrunk to what a small model reads (STORED_SIDE, JPEG).
 * Returns the file name and the stored size; the regions stay in the pixels of the image as sent.
 */
function keepImage(img: PageImage): { file: string; stored: [number, number] } {
  const file = `${createHash('sha1').update(img.base64).digest('hex').slice(0, 24)}.jpg`
  const scale = Math.min(1, STORED_SIDE / Math.max(img.width, img.height))
  const stored: [number, number] = [Math.round(img.width * scale), Math.round(img.height * scale)]
  const path = join(root(), 'images', file)
  if (!existsSync(path)) {
    let image = nativeImage.createFromBuffer(Buffer.from(img.base64, 'base64'))
    if (scale < 1) image = image.resize({ width: stored[0], height: stored[1], quality: 'good' })
    writeFileSync(path, image.toJPEG(STORED_QUALITY))
  }
  return { file, stored }
}

/** Chapter names become file names: anything Windows refuses goes. */
const fileName = (chapter: string): string => chapter.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'sem-nome'

export function recordExample(ex: Example): void {
  if (process.env.MI_DATASET === '0' || !TEACHER.test(ex.model)) return
  try {
    const keys = recordedKeys()
    if (keys.has(ex.key)) return
    mkdirSync(join(root(), 'images'), { recursive: true })
    mkdirSync(join(root(), 'annotations'), { recursive: true })
    const line = {
      key: ex.key,
      chapter: ex.req.chapter ?? '',
      page: ex.req.pageNumber,
      kind: ex.kind,
      model: ex.model,
      speed: ex.speed,
      images: ex.images.map((img) => ({ ...keepImage(img), width: img.width, height: img.height })),
      slices: ex.kind === 'page' ? ex.req.images.length : 0,
      regions: ex.req.regions,
      prompt: ex.prompt,
      answer: ex.answer,
      at: new Date().toISOString()
    }
    appendFileSync(join(root(), 'annotations', `${fileName(ex.req.chapter ?? '')}.jsonl`), JSON.stringify(line) + '\n')
    appendFileSync(join(root(), 'recorded.txt'), ex.key + '\n')
    keys.add(ex.key)
  } catch (err) {
    // The dataset is a by-product: a full disk or a locked file must not stop the translation.
    console.error('[dataset] not recorded:', err)
  }
}
