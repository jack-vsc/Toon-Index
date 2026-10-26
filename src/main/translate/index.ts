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
  type TranslateRequest
} from '../../shared/types'
import { getApiKey, getSettings } from '../settings'
import { ensureLocalServer } from '../localAi'
import { listCursorModels, pickDefaultCursorModel, runCursor } from './cursorProvider'
import { describeError, FormatError, TruncatedError } from './errors'
import { listOpenAIModels, runOpenAI } from './openaiProvider'
import { buildFollowUp, buildPrompt, parseBlocks } from './prompt'

const active = new Map<string, AbortController>()

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
  const apiKey = requireReady(profile, getApiKey(profile.id))

  const controller = new AbortController()
  active.set(req.requestId, controller)
  // Same images + same prompt + same model = same answer, so re-translating a chapter costs nothing.
  const ask = async (prompt: string, images: TranslateRequest['images'], parse: (raw: string) => ReturnType<typeof parseBlocks>) => {
    const modelReq = { ...req, images }
    const cacheFile = join(cacheDir(), `${cacheKey(prompt, modelReq, settings.speed, profile)}.txt`)
    if (existsSync(cacheFile)) {
      try {
        return parse(readFileSync(cacheFile, 'utf8'))
      } catch {
        // Unreadable cache entry: ask the model again.
      }
    }
    // Models now and then stop mid-answer, or loop on a character until the token limit; a second try,
    // a little less deterministic so it does not walk into the same loop, usually comes back whole.
    for (let attempt = 1; ; attempt++) {
      try {
        const raw = await callModel(profile, apiKey, prompt, modelReq, settings.speed, controller.signal, attempt > 1 ? 0.7 : 0.2)
        const parsed = parse(raw)
        writeFileSync(cacheFile, raw, 'utf8')
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
    const { blocks, answered, skipped } = await ask(buildPrompt(req, settings), [...req.images, ...req.key], (raw) => parseBlocks(raw, req))
    // A whole paragraph of lettering is now and then skipped with the artwork; asking about it on its
    // own gets it translated (credits and watermarks get skipped again).
    const missing = req.regions
      .filter((r) => !answered.has(r.id) || (skipped.has(r.id) && r.glyphs >= SKIPPED_PARAGRAPH))
      .map((r) => r.id)
    if (missing.length && req.key.length) {
      const more = await ask(buildFollowUp(missing, req, settings), req.key, (raw) => parseBlocks(raw, req, true))
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
  for (const img of req.images) hash.update(img.base64)
  return hash.digest('hex')
}

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'translation-cache')
  mkdirSync(dir, { recursive: true })
  return dir
}
