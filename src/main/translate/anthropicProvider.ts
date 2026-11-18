import Anthropic from '@anthropic-ai/sdk'
import { CANCELLED, type ThinkingLevel, type TranslateRequest } from '../../shared/types'
import { HttpError, TruncatedError } from './errors'

/** A page needs a few thousand tokens; with thinking on, the thinking counts here too. */
const MAX_OUTPUT_TOKENS = 16_000

/** Anthropic's own API: whether the profile's address is it (its OpenAI-compatible route can't turn thinking off). */
export function isAnthropic(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

/**
 * Asks Claude through Anthropic's Messages API. The newer models think before answering unless told
 * not to, and that thinking is billed as output on every page: `thinking` sets how much ('off' by
 * default). A model that cannot turn it off (Opus 5.5, Sonnet 5.5) runs at low effort instead.
 */
export async function runAnthropic(
  prompt: string,
  req: TranslateRequest,
  apiKey: string,
  model: string,
  signal: AbortSignal,
  thinking: ThinkingLevel = 'off'
): Promise<string> {
  const client = new Anthropic({ apiKey, maxRetries: 4 })
  const content: Anthropic.ContentBlockParam[] = [
    ...req.images.map(
      (img): Anthropic.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } })
    ),
    { type: 'text', text: prompt }
  ]
  const ask = (level: ThinkingLevel) =>
    client.messages.create(
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(level === 'off' ? { thinking: { type: 'disabled' } } : { output_config: { effort: level } }),
        messages: [{ role: 'user', content }]
      },
      { signal }
    )
  try {
    let response: Anthropic.Message
    try {
      response = await ask(thinking)
    } catch (err) {
      if (thinking !== 'off' || !(err instanceof Anthropic.BadRequestError) || !/thinking/i.test(err.message)) throw err
      response = await ask('low')
    }
    const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    if (response.stop_reason === 'refusal') throw new HttpError(400, JSON.stringify({ error: { message: 'content_policy: o modelo recusou esta página.' } }))
    if (response.stop_reason === 'max_tokens') {
      throw new TruncatedError(`A resposta da IA foi cortada no limite de ${MAX_OUTPUT_TOKENS} tokens. Fim da resposta: ${text.slice(-200)}`, text)
    }
    if (!text) throw new Error(`Resposta vazia da API (stop_reason: ${response.stop_reason ?? 'desconhecido'}).`)
    return text
  } catch (err) {
    if (signal.aborted) throw new Error(CANCELLED)
    // The SDK already tried rate limits and server errors again; the rest reads the error as from any API.
    if (err instanceof Anthropic.APIError && err.status) {
      const retryAfter = Number(err.headers?.get?.('retry-after'))
      throw new HttpError(err.status, JSON.stringify(err.error ?? { error: { message: err.message } }), retryAfter > 0 ? retryAfter : undefined)
    }
    throw err
  }
}
