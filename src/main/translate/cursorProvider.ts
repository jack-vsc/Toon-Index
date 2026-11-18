import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Agent, Cursor, JsonlLocalAgentStore, type ModelListItem, type ModelParameterValue } from '@cursor/sdk'
import { CANCELLED, type ModelOption, type Speed, type TranslateRequest } from '../../shared/types'

/** Empty dir so the agent never sees the user's files; tools are disabled anyway. */
function agentWorkDir(): string {
  const dir = join(app.getPath('userData'), 'agent-workdir')
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function runCursor(
  prompt: string,
  req: TranslateRequest,
  apiKey: string,
  model: string,
  speed: Speed,
  signal: AbortSignal
): Promise<string> {
  // The SDK's default SQLite store fails inside Electron ("unable to open database file") and the
  // harness then re-sends the model call; a throwaway JSONL store per request avoids both.
  const storeDir = join(app.getPath('userData'), 'agent-runs', randomUUID())
  mkdirSync(storeDir, { recursive: true })

  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined
  let onAbort: (() => void) | undefined
  try {
    signal.throwIfAborted()
    agent = await Agent.create({
      apiKey,
      model: { id: model, params: await speedParams(apiKey, model, speed) },
      name: `Toon Index - página ${req.pageNumber}`,
      tools: [],
      local: {
        cwd: agentWorkDir(),
        settingSources: [],
        store: new JsonlLocalAgentStore(storeDir),
        enableAgentRetries: false
      }
    })

    signal.throwIfAborted()
    const run = await agent.send({
      text: prompt,
      images: req.images.map((img) => ({
        data: img.base64,
        mimeType: img.mimeType,
        dimension: { width: img.width, height: img.height }
      }))
    })
    onAbort = () => void run.cancel().catch(() => undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    signal.throwIfAborted()

    let streamed = ''
    for await (const event of run.stream()) {
      if (event.type !== 'assistant') continue
      for (const block of event.message.content) {
        if (block.type === 'text') streamed += block.text
      }
    }

    const result = await run.wait()
    signal.throwIfAborted()
    if (result.status !== 'finished') {
      throw new Error(`Execução do agente terminou com status "${result.status}": ${result.error?.message ?? 'sem detalhes'}`)
    }
    return result.result?.trim() || streamed
  } catch (err) {
    if (signal.aborted) throw new Error(CANCELLED)
    throw err
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    await agent?.[Symbol.asyncDispose]().catch(() => undefined)
    rmSync(storeDir, { recursive: true, force: true })
  }
}

const modelCache = new Map<string, Promise<ModelListItem[]>>()

function cachedModels(apiKey: string): Promise<ModelListItem[]> {
  let models = modelCache.get(apiKey)
  if (!models) {
    models = Cursor.models.list({ apiKey })
    models.catch(() => modelCache.delete(apiKey))
    modelCache.set(apiKey, models)
  }
  return models
}

export async function listCursorModels(apiKey: string): Promise<ModelOption[]> {
  modelCache.delete(apiKey)
  const models = await cachedModels(apiKey)
  return models.filter((m) => m.id !== 'default').map((m) => ({ id: m.id, label: m.displayName || m.id }))
}

/** Gemini models are the most reliable at returning bounding boxes, and Flash is fast. */
export function pickDefaultCursorModel(models: ModelOption[]): string {
  const preferences = [/gemini.*flash/i, /gemini/i, /claude.*sonnet/i, /claude/i, /gpt-5/i, /gpt/i]
  for (const pattern of preferences) {
    const match = models.find((m) => pattern.test(m.id))
    if (match) return match.id
  }
  return models[0]?.id ?? 'default'
}

/** Translates the speed preset into whatever reasoning knobs the chosen model exposes. */
async function speedParams(apiKey: string, model: string, speed: Speed): Promise<ModelParameterValue[]> {
  const info = (await cachedModels(apiKey).catch(() => [])).find((m) => m.id === model)
  const params: ModelParameterValue[] = []
  for (const def of info?.parameters ?? []) {
    const values = def.values.map((v) => v.value)
    const pick = (...wanted: string[]) => wanted.find((w) => values.includes(w))
    let value: string | undefined
    if (['reasoning_effort', 'effort', 'reasoning'].includes(def.id)) {
      value =
        speed === 'fast' ? pick('low', 'minimal', 'medium') : speed === 'balanced' ? pick('medium', 'low') : pick('high', 'medium')
    } else if (def.id === 'thinking') {
      value = speed === 'quality' ? 'true' : 'false'
    } else if (def.id === 'fast') {
      value = speed === 'quality' ? 'false' : pick('true')
    }
    if (value && values.includes(value)) params.push({ id: def.id, value })
  }
  return params
}
