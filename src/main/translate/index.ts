import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appError, isAppError } from '../../shared/errors'
import {
  activeProfile,
  CANCELLED,
  isLocalProfile,
  LOCAL_AI_PROFILE_ID,
  type ApiProfile,
  type AppSettings,
  type ModelOption,
  type Speed,
  type TextBlock,
  type TextRequest,
  type TranslateRequest
} from '../../shared/types'
import { getApiKey, getSettings } from '../settings'
import { ensureLocalServer } from '../localAi'
import { listCursorModels, pickDefaultCursorModel, runCursor } from './cursorProvider'
import { describeError, FormatError, TruncatedError } from './errors'
import { listOpenAIModels, runOpenAI } from './openaiProvider'
import { isAnthropic, runAnthropic } from './anthropicProvider'
import { buildFollowUp, buildNovelPrompt, buildPrompt, parseBlocks, parseNovel } from './prompt'
import { recordExample, type Example } from './dataset'

const active = new Map<string, AbortController>()
const SPEEDS: Speed[] = ['fast', 'balanced', 'quality']

/** 32x32 white PNG: proves the model accepts images without spending much. */
const TEST_IMAGE = {
  base64: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAAAFklEQVR4nGP4TwAwjCoYVTCqYKQqAAA/aPwuq5iY/wAAAABJRU5ErkJggg==',
  mimeType: 'image/png' as const,
  width: 32,
  height: 32
}
const TEST_TIMEOUT_MS = 90_000
/** Glyphs in a box the model skipped above which it is asked about again (includes small asides). */
const SKIPPED_PARAGRAPH = 3

export async function translate(req: TranslateRequest): Promise<TextBlock[][]> {
  const settings = getSettings()
  const profile = activeProfile(settings)
  if (!profile) throw appError({ code: 'auth', message: 'Cadastre uma API nas configurações antes de traduzir.' })
  // Rebuilding the training dataset from the cache (MI_CACHE_ONLY=1) never calls a model, so needs no key.
  const cacheOnly = process.env.MI_CACHE_ONLY === '1'
  const apiKey = cacheOnly ? '' : requireReady(profile, getApiKey(profile.id))

  const controller = new AbortController()
  active.set(req.requestId, controller)
  // Same images + same prompt + same model = same answer, so re-translating a chapter costs nothing.
  const ask = async (
    kind: Example['kind'],
    prompt: string,
    images: TranslateRequest['images'],
    parse: (raw: string) => ReturnType<typeof parseBlocks>
  ) => {
    const modelReq = { ...req, images }
    const keep = (key: string, answer: string, from: ApiProfile, speed: Speed) =>
      recordExample({ key, req, kind, prompt, images, answer, model: from.model, speed })
    const key = cacheKey(prompt, modelReq, settings.speed, profile)
    const cacheFile = join(cacheDir(), `${key}.txt`)
    if (existsSync(cacheFile)) {
      try {
        const raw = readFileSync(cacheFile, 'utf8')
        const parsed = parse(raw)
        keep(key, raw, profile, settings.speed)
        return parsed
      } catch {
        // Unreadable cache entry: ask the model again.
      }
    }
    if (cacheOnly) {
      // The page may have been translated with another API or speed than the ones chosen now.
      for (const other of settings.profiles) {
        for (const speed of SPEEDS) {
          const otherKey = cacheKey(prompt, modelReq, speed, other)
          const file = join(cacheDir(), `${otherKey}.txt`)
          if (!existsSync(file)) continue
          const raw = readFileSync(file, 'utf8')
          const parsed = parse(raw)
          keep(otherKey, raw, other, speed)
          return parsed
        }
      }
      throw new Error('Esta página não está no cache de traduções.')
    }
    // Models now and then stop mid-answer, or loop on a character until the token limit; a second try,
    // a little less deterministic so it does not walk into the same loop, usually comes back whole.
    for (let attempt = 1; ; attempt++) {
      try {
        const raw = await callModel(profile, apiKey, prompt, modelReq, settings.speed, controller.signal, attempt > 1 ? 0.7 : 0.2)
        const parsed = parse(raw)
        writeFileSync(cacheFile, raw, 'utf8')
        keep(key, raw, profile, settings.speed)
        return parsed
      } catch (err) {
        if (!(err instanceof FormatError)) throw err
        if (attempt < 2) continue
        // Looping twice: keep the blocks it finished before the loop (not cached, so a later run asks
        // again); the boxes they leave out are asked about on their own.
        if (err instanceof TruncatedError) {
          try {
            return parse(err.partial)
          } catch {
            // Nothing usable before the cut.
          }
        }
        throw err
      }
    }
  }
  try {
    const { blocks, answered, skipped } = await ask('page', buildPrompt(req, settings), [...req.images, ...req.key], (raw) => parseBlocks(raw, req))
    // A whole paragraph of lettering is now and then skipped with the artwork; asking about it on its
    // own gets it translated (credits and watermarks get skipped again).
    const missing = req.regions
      .filter((r) => !answered.has(r.id) || (skipped.has(r.id) && r.glyphs >= SKIPPED_PARAGRAPH))
      .map((r) => r.id)
    if (missing.length && req.key.length) {
      const more = await ask('followup', buildFollowUp(missing, req, settings), req.key, (raw) => parseBlocks(raw, req, true))
      more.blocks.forEach((list, i) => blocks[i].push(...list))
    }
    // Models return sound effects now and then even when told not to; they stay in the artwork.
    const kept = settings.translateSfx ? blocks : blocks.map((list) => list.filter((b) => b.kind !== 'sfx'))
    return kept.map((list) => list.map(matchCase))
  } catch (err) {
    if (controller.signal.aborted) throw new Error(CANCELLED)
    throw describeError(err, profile)
  } finally {
    active.delete(req.requestId)
  }
}

/**
 * A novel's paragraphs (text read from the PDF, no images), translated one for one. Cached like the
 * pages: the same paragraphs with the same model cost nothing the second time.
 */
export async function translateText(req: TextRequest): Promise<string[]> {
  const settings = getSettings()
  const profile = activeProfile(settings)
  if (!profile) throw appError({ code: 'auth', message: 'Cadastre uma API nas configurações antes de traduzir.' })
  const apiKey = requireReady(profile, getApiKey(profile.id))
  const controller = new AbortController()
  active.set(req.requestId, controller)
  const prompt = buildNovelPrompt(req.paragraphs, req.context, settings)
  const modelReq: TranslateRequest = { images: [], key: [], regions: [], pageNumber: req.pageNumber, requestId: req.requestId }
  const cacheFile = join(cacheDir(), `${cacheKey(prompt, modelReq, settings.speed, profile)}.txt`)
  try {
    if (existsSync(cacheFile)) {
      try {
        return parseNovel(readFileSync(cacheFile, 'utf8'), req.paragraphs.length)
      } catch {
        // Unreadable cache entry: ask the model again.
      }
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const raw = await callModel(profile, apiKey, prompt, modelReq, settings.speed, controller.signal, attempt > 1 ? 0.7 : 0.2)
        const parsed = parseNovel(raw, req.paragraphs.length)
        writeFileSync(cacheFile, raw, 'utf8')
        return parsed
      } catch (err) {
        // A paragraph missing or two run together: once more, then the renderer splits the batch.
        if (!(err instanceof FormatError) || attempt >= 2) throw err
      }
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error(CANCELLED)
    if (err instanceof FormatError) throw appError({ code: 'format', message: err.message })
    throw describeError(err, profile)
  } finally {
    active.delete(req.requestId)
  }
}

/** A short question to the model set for translating, answered as text (no images, nothing cached). */
export async function askModel(prompt: string): Promise<string> {
  const settings = getSettings()
  const profile = activeProfile(settings)
  if (!profile) throw appError({ code: 'auth', message: 'Cadastre uma API nas configurações.' })
  const apiKey = requireReady(profile, getApiKey(profile.id))
  const req: TranslateRequest = { images: [], key: [], regions: [], pageNumber: 0, requestId: `ask-${Date.now()}` }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    return await callModel(profile, apiKey, prompt, req, settings.speed, controller.signal, 0)
  } catch (err) {
    throw describeError(err, profile)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Lettering in capitals stays in capitals: small local models answer in sentence case even when the
 * original (and the prompt's examples) are all uppercase.
 */
function matchCase(block: TextBlock): TextBlock {
  const share = (text: string, upper: boolean): number => {
    const letters = [...text].filter((c) => c.toLowerCase() !== c.toUpperCase())
    return letters.length ? letters.filter((c) => (upper ? c === c.toUpperCase() : c === c.toLowerCase())).length / letters.length : 0
  }
  // Lettering in capitals is translated in capitals, a word or two the model left small included
  // ("PERDIDOS, então VOCÊ").
  if (share(block.original, true) < 0.9 || share(block.translation, false) === 0) return block
  return { ...block, translation: block.translation.toLocaleUpperCase('pt-BR') }
}

/** Sends one tiny request with an image, using a profile that may not be saved yet. */
export async function testApi(profile: ApiProfile, typedKey?: string): Promise<{ ms: number }> {
  const apiKey = requireReady(profile, typedKey?.trim() || getApiKey(profile.id))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  const started = Date.now()
  try {
    const req: TranslateRequest = { images: [TEST_IMAGE], key: [], regions: [], pageNumber: 0, requestId: 'test' }
    await callModel(profile, apiKey, 'Respond with the JSON object {"ok":true} and nothing else.', req, 'fast', controller.signal)
    return { ms: Date.now() - started }
  } catch (err) {
    if (controller.signal.aborted) {
      throw appError({ code: 'server', message: `A API não respondeu em ${TEST_TIMEOUT_MS / 1000}s.` })
    }
    throw describeError(err, profile)
  } finally {
    clearTimeout(timer)
  }
}

export async function listModels(profile: ApiProfile, typedKey?: string): Promise<{ models: ModelOption[]; suggested: string }> {
  const apiKey = typedKey?.trim() || getApiKey(profile.id)
  try {
    if (profile.kind === 'openai') return { models: await listOpenAIModels(profile.baseUrl, apiKey), suggested: '' }
    if (!apiKey) throw appError({ code: 'auth', message: 'Informe a chave de API do Cursor primeiro.' })
    const models = await listCursorModels(apiKey)
    return { models, suggested: pickDefaultCursorModel(models) }
  } catch (err) {
    throw isAppError(err) ? err : describeError(err, profile)
  }
}

function requireReady(profile: ApiProfile, apiKey: string | undefined): string {
  // A model served on this computer takes any key.
  if (!apiKey && isLocalProfile(profile)) apiKey = 'local'
  if (!apiKey) throw appError({ code: 'auth', message: `A API "${profile.name}" está sem chave. Cadastre a chave nas configurações.` })
  if (profile.kind === 'openai' && !profile.baseUrl.trim()) {
    throw appError({ code: 'model', message: `Informe a URL base da API "${profile.name}" nas configurações.` })
  }
  if (profile.kind === 'openai' && apiKey.startsWith('sk-or-') && !profile.baseUrl.includes('openrouter.ai')) {
    throw appError({
      code: 'auth',
      message: `Essa chave é do OpenRouter, mas a URL base da API "${profile.name}" é ${profile.baseUrl}. Use https://openrouter.ai/api/v1.`
    })
  }
  if (!profile.model) throw appError({ code: 'model', message: `Escolha um modelo para a API "${profile.name}" nas configurações.` })
  return apiKey
}

async function callModel(
  profile: ApiProfile,
  apiKey: string,
  prompt: string,
  req: TranslateRequest,
  speed: Speed,
  signal: AbortSignal,
  temperature?: number
) {
  if (profile.id === LOCAL_AI_PROFILE_ID) await ensureLocalServer(profile.model)
  if (profile.kind === 'openai' && isAnthropic(profile.baseUrl)) return runAnthropic(prompt, req, apiKey, profile.model, signal, profile.thinking)
  return profile.kind === 'cursor'
    ? runCursor(prompt, req, apiKey, profile.model, speed, signal)
    : runOpenAI(prompt, req, apiKey, profile.baseUrl, profile.model, signal, temperature, isLocalProfile(profile), getSettings().aiDevice === 'cpu')
}

export function currentModelLabel(): string {
  return activeProfile(getSettings())?.model ?? ''
}

/** Aborts the given requests, or every running request when no ids are given. */
export function cancelTranslations(requestIds?: string[]): void {
  for (const [id, controller] of active) {
    if (!requestIds || requestIds.includes(id)) controller.abort()
  }
}

function cacheKey(prompt: string, req: TranslateRequest, speed: AppSettings['speed'], profile: ApiProfile): string {
  const hash = createHash('sha256')
  const model = profile.kind === 'cursor' ? profile.model : `${profile.baseUrl}|${profile.model}`
  hash.update(`${profile.kind}|${model}|${speed}|${prompt}`)
  // How much the model thought changes its answer; 'off' keeps the key the earlier answers were kept under.
  if (profile.thinking && profile.thinking !== 'off') hash.update(`|thinking:${profile.thinking}`)
  for (const img of req.images) hash.update(img.base64)
  return hash.digest('hex')
}

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'translation-cache')
  mkdirSync(dir, { recursive: true })
  return dir
}
