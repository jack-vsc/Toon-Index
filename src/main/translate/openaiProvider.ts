import { net } from 'electron'
import { CANCELLED, type ModelOption, type TranslateRequest } from '../../shared/types'
import { FormatError, HttpError } from './errors'

const MAX_ATTEMPTS = 3
const MAX_OUTPUT_TOKENS = 8192

/** Works with any OpenAI-compatible chat completions API (OpenAI, Gemini, OpenRouter, Ollama...). */
export async function runOpenAI(
  prompt: string,
  req: TranslateRequest,
  apiKey: string,
  baseUrl: string,
  model: string,
  signal: AbortSignal
): Promise<string> {
  try {
    return await withRetries(prompt, req, apiKey, baseUrl, model, signal)
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
  signal: AbortSignal
): Promise<string> {
  let jsonMode = true
  for (let attempt = 1; ; attempt++) {
    try {
      return await request(prompt, req, apiKey, baseUrl, model, jsonMode, signal)
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      if (jsonMode && err.status === 400 && /response_format|json_object|json mode/i.test(err.body)) {
        jsonMode = false
        attempt--
        continue
      }
      if (attempt >= MAX_ATTEMPTS || !isTransient(err)) throw err
      await sleep(Math.min(20, err.retryAfter ?? 2 * 2 ** (attempt - 1)) * 1000, signal)
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
  signal: AbortSignal
): Promise<string> {
  // Electron's fetch: Node's gives up when the answer takes over five minutes to start, as a local
  // model on a small GPU may for a page of images.
  const response = await net.fetch(`${trimUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': 'Manga Index'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      // A page needs a few thousand tokens; models stuck repeating themselves stop here instead of later.
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(jsonMode && { response_format: { type: 'json_object' } }),
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
  }
  // OpenRouter reports some upstream failures inside a 200 response.
  if (data.error) throw new HttpError(Number(data.error.code) || 500, body)
  const choice = data.choices?.[0]
  const content = choice?.message?.content
  if (!content) {
    throw new Error(`Resposta vazia da API (finish_reason: ${choice?.finish_reason ?? 'desconhecido'}): ${body.slice(0, 300)}`)
  }
  if (choice?.finish_reason === 'length') {
    throw new FormatError(`A resposta da IA foi cortada no limite de ${MAX_OUTPUT_TOKENS} tokens (o modelo provavelmente entrou em repetição). Fim da resposta: ${content.slice(-200)}`)
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
