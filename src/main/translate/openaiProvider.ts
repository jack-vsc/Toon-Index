import { net } from 'electron'
import { CANCELLED, LOCAL_AI_BASE_URL, type ModelOption, type TranslateRequest } from '../../shared/types'
import { HttpError, TruncatedError } from './errors'

const MAX_ATTEMPTS = 3
/** A rate limit (OpenRouter's "temporarily rate-limited upstream") lasts minutes, not seconds. */
const RATE_LIMIT_ATTEMPTS = 7
const MAX_OUTPUT_TOKENS = 8192
/**
 * A local model answering a few tokens a second would take half an hour to reach 8192 when it gets
 * stuck repeating itself; a page's answer takes under 2000.
 */
const LOCAL_MAX_OUTPUT_TOKENS = 3072

/**
 * JSON on one line, for the app's own llama.cpp server: left to itself the model indents its answer,
 * which nearly doubles what it writes (and how long a page takes). A space after ":" and "," stays
 * allowed: without it the model loses its way.
 */
const COMPACT_JSON = String.raw`root ::= object
value ::= object | array | string | number | "true" | "false" | "null"
object ::= "{" sp ( string sp ":" sp value ( sp "," sp string sp ":" sp value )* )? sp "}"
array ::= "[" sp ( value ( sp "," sp value )* )? sp "]"
string ::= "\"" ( [^"\\\x7F\x00-\x1F] | "\\" ( ["\\/bfnrt] | "u" [0-9a-fA-F]{4} ) )* "\""
number ::= "-"? [0-9]+ ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?
sp ::= " "?`

/** Works with any OpenAI-compatible chat completions API (OpenAI, Gemini, OpenRouter, Ollama...). */
export async function runOpenAI(
  prompt: string,
  req: TranslateRequest,
  apiKey: string,
  baseUrl: string,
  model: string,
  signal: AbortSignal,
  temperature = 0.2,
  /** A model on this computer: answers without thinking first (Gemma 4, Qwen 3 thinking…), which takes minutes on a small GPU. */
  local = false,
  /** Ollama on this computer, kept off the graphics card. */
  cpu = false
): Promise<string> {
  try {
    if (local && cpu && isOllama(baseUrl)) return await requestOllama(prompt, req, baseUrl, model, signal, temperature)
    return await withRetries(prompt, req, apiKey, baseUrl, model, signal, temperature, local)
  } catch (err) {
    if (signal.aborted) throw new Error(CANCELLED)
    throw err
  }
}

async function withRetries(
  prompt: string,
  req: TranslateRequest,
  apiKey: string,
  baseUrl: string,
  model: string,
  signal: AbortSignal,
  temperature: number,
  local: boolean
): Promise<string> {
  let jsonMode = true
  // Newer models (Claude's among them) take no temperature: it is left out once the API says so.
  let withTemperature: number | null = temperature
  for (let attempt = 1; ; attempt++) {
    try {
      return await request(prompt, req, apiKey, baseUrl, model, jsonMode, signal, withTemperature, local)
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      if (jsonMode && err.status === 400 && /response_format|json_object|json mode/i.test(err.body)) {
        jsonMode = false
        attempt--
        continue
      }
      if (withTemperature !== null && err.status === 400 && /temperature/i.test(err.body)) {
        withTemperature = null
        attempt--
        continue
      }
      if (!isTransient(err)) throw err
      const limited = err.status === 429
      if (attempt >= (limited ? RATE_LIMIT_ATTEMPTS : MAX_ATTEMPTS)) throw err
      // 5, 10, 20, 40, 60, 60 s on a rate limit (about three minutes in all); pages running side by side
      // wait a little apart, so they do not all come back at the same moment.
      const backoff = limited ? Math.min(60, 5 * 2 ** (attempt - 1)) : Math.min(20, 2 * 2 ** (attempt - 1))
      const seconds = err.retryAfter ? Math.min(60, err.retryAfter) : backoff * (0.8 + 0.4 * Math.random())
      console.warn(`[translate] HTTP ${err.status}, trying again in ${Math.round(seconds)}s (attempt ${attempt + 1})`)
      await sleep(seconds * 1000, signal)
    }
  }
}

/** Rate limits and server hiccups pass; an exhausted quota does not. */
function isTransient(err: HttpError): boolean {
  if (/quota|per-day|credits/i.test(err.body)) return false
  return err.status === 429 || err.status >= 500
}

async function request(
  prompt: string,
  req: TranslateRequest,
  apiKey: string,
  baseUrl: string,
  model: string,
  jsonMode: boolean,
  signal: AbortSignal,
  temperature: number | null,
  local: boolean
): Promise<string> {
  const started = Date.now()
  // Electron's fetch: Node's gives up when the answer takes over five minutes to start, as a local
  // model on a small GPU may for a page of images.
  const response = await net.fetch(`${trimUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': 'Toon Index'
    },
    body: JSON.stringify({
      model,
      ...(temperature !== null && { temperature }),
      // A page needs a few thousand tokens; models stuck repeating themselves stop here instead of later.
      max_tokens: local ? LOCAL_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
      ...(jsonMode && (trimUrl(baseUrl) === LOCAL_AI_BASE_URL ? { grammar: COMPACT_JSON } : { response_format: { type: 'json_object' } })),
      ...(local && { reasoning_effort: 'none' }),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...req.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'high' }
            }))
          ]
        }
      ]
    })
  })

  const body = await response.text()
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new HttpError(response.status, body, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined)
  }
  const data = JSON.parse(body) as {
    error?: { code?: number; message?: string }
    choices?: { message?: { content?: string }; finish_reason?: string }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  // What a page costs on this computer: how long, and how much read and written.
  if (local && data.usage) {
    const { prompt_tokens: read, completion_tokens: written } = data.usage
    console.log(`[translate] ${model}: ${req.images.length} images, ${read} tokens in, ${written} out, ${((Date.now() - started) / 1000).toFixed(1)}s (${data.choices?.[0]?.finish_reason})`)
  }
  // OpenRouter reports some upstream failures inside a 200 response.
  if (data.error) throw new HttpError(Number(data.error.code) || 500, body)
  const choice = data.choices?.[0]
  const content = choice?.message?.content
  if (!content) {
    throw new Error(`Resposta vazia da API (finish_reason: ${choice?.finish_reason ?? 'desconhecido'}): ${body.slice(0, 300)}`)
  }
  if (choice?.finish_reason === 'length') {
    throw new TruncatedError(
      `A resposta da IA foi cortada no limite de ${local ? LOCAL_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS} tokens (o modelo provavelmente entrou em repetição). Fim da resposta: ${content.slice(-200)}`,
      content
    )
  }
  return content
}

function isOllama(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).port === '11434'
  } catch {
    return false
  }
}

/**
 * Ollama's own API, which (unlike its OpenAI-compatible one) takes num_gpu: 0 keeps the whole model in
 * the RAM, on the processor. Ollama loads the model again when this changes.
 */
async function requestOllama(prompt: string, req: TranslateRequest, baseUrl: string, model: string, signal: AbortSignal, temperature: number): Promise<string> {
  const response = await net.fetch(`${new URL(baseUrl).origin}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      options: { temperature, num_predict: LOCAL_MAX_OUTPUT_TOKENS, num_gpu: 0 },
      messages: [{ role: 'user', content: prompt, images: req.images.map((img) => img.base64) }]
    })
  })
  const body = await response.text()
  if (!response.ok) throw new HttpError(response.status, body)
  const data = JSON.parse(body) as { error?: string; message?: { content?: string }; done_reason?: string }
  if (data.error) throw new HttpError(500, body)
  const content = data.message?.content
  if (!content) throw new Error(`Resposta vazia do Ollama: ${body.slice(0, 300)}`)
  if (data.done_reason === 'length') {
    throw new TruncatedError(
      `A resposta da IA foi cortada no limite de ${LOCAL_MAX_OUTPUT_TOKENS} tokens (o modelo provavelmente entrou em repetição). Fim da resposta: ${content.slice(-200)}`,
      content
    )
  }
  return content
}

interface RawModel {
  id: string
  name?: string
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  pricing?: { prompt?: string; completion?: string }
}

/**
 * Models of the endpoint that read images and answer with text only (when the API says so), with prices
 * when it lists them. OpenRouter's ":batch" variants don't answer right away, so they are left out.
 */
export async function listOpenAIModels(baseUrl: string, apiKey: string | undefined): Promise<ModelOption[]> {
  const response = await fetch(`${trimUrl(baseUrl)}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  })
  const body = await response.text()
  if (!response.ok) throw new HttpError(response.status, body)
  const data = JSON.parse(body) as { data?: RawModel[] }
  return (data.data ?? [])
    .filter((m) => {
      const { input_modalities: input, output_modalities: output } = m.architecture ?? {}
      return (!input || input.includes('image')) && !output?.includes('image') && !m.id.endsWith(':batch')
    })
    .map((m) => ({ id: m.id, label: m.name ?? m.id, price: modelPrice(m) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function modelPrice(m: RawModel): string | undefined {
  if (m.pricing?.prompt === undefined) return undefined
  const perMillion = (price?: string) => `$${(Number(price) * 1e6).toFixed(2)}`
  return `${perMillion(m.pricing.prompt)} / ${perMillion(m.pricing.completion)} por 1M tokens`
}

function trimUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error(CANCELLED))
      },
      { once: true }
    )
  })
}
