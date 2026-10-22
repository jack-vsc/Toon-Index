import { AuthenticationError, ConfigurationError, NetworkError, RateLimitError } from '@cursor/sdk'
import { appError, type AppError } from '../../shared/errors'
import { isLocalProfile, type ApiProfile } from '../../shared/types'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** Seconds, from the Retry-After header. */
    readonly retryAfter?: number
  ) {
    super(`HTTP ${status}: ${providerMessage(body)}`)
  }
}

/** The model answered, but not with the JSON the prompt asked for. */
export class FormatError extends Error {}

const QUOTA = /out of usage|usage limit|increase (your )?limits?|spend(ing)? limit|insufficient_quota|exceeded your current quota|quota exceeded|free-models-per-day/i
const CREDITS = /insufficient (credits|balance|funds)|more credits|can only afford|payment required|credit balance/i
const BLOCKED = /flagged|moderation|content[_ ](policy|filter)|safety|prohibited[_ ]content/i
const AUTH = /unauthori[sz]ed|invalid.{0,10}api.?key|incorrect api key|no auth credentials|authentication|permission denied/i
const VISION = /image input|support(s)? images?|vision|image_url|multimodal/i
const MODEL = /model.{0,40}(not found|does not exist|is not a valid|invalid|unknown|not available)|no endpoints found|not a valid model/i
const RATE = /rate.?limit|too many requests|resource.?exhausted/i
const SERVER = /overloaded|unavailable|bad gateway|timed? ?out|internal server error/i
const NETWORK = /fetch failed|enotfound|econnrefused|econnreset|etimedout|getaddrinfo|network|net::ERR_/i

/** Turns whatever a provider threw into a message that says what happened and what to do. */
export function describeError(err: unknown, profile: ApiProfile): Error {
  return appError(classify(err, profile))
}

function classify(err: unknown, profile: ApiProfile): AppError {
  const detail = err instanceof Error ? err.message : String(err)
  const status = err instanceof HttpError ? err.status : undefined
  const is = (pattern: RegExp) => pattern.test(detail)
  const api = `"${profile.name}"`
  const model = `"${profile.model}"`

  if (err instanceof FormatError) {
    return { code: 'format', message: 'A IA respondeu fora do formato esperado. Tente de novo; se repetir, use outro modelo.', detail }
  }
  if (is(QUOTA)) {
    return { code: 'quota', message: `A cota da API ${api} acabou. Troque de API nas configurações ou aumente o limite da conta.`, detail }
  }
  if (status === 402 || is(CREDITS)) {
    return { code: 'credits', message: `Sem créditos na API ${api}. Adicione créditos no site do provedor ou troque de API.`, detail }
  }
  if (is(BLOCKED)) {
    return { code: 'blocked', message: 'O provedor recusou esta página pela política de conteúdo. Tente outro modelo.', detail }
  }
  if (err instanceof AuthenticationError || status === 401 || status === 403 || is(AUTH)) {
    return { code: 'auth', message: `A chave da API ${api} foi recusada (inválida, revogada ou sem permissão). Confira a chave nas configurações.`, detail }
  }
  if (is(VISION)) {
    return { code: 'vision', message: `O modelo ${model} não aceita imagens. Escolha um modelo com visão.`, detail }
  }
  if (err instanceof ConfigurationError || status === 404 || is(MODEL)) {
    return { code: 'model', message: `O modelo ${model} não existe na API ${api} ou não está liberado para sua conta. Confira o ID do modelo.`, detail }
  }
  if (err instanceof RateLimitError || status === 429 || is(RATE)) {
    return { code: 'rate', message: 'Limite de requisições atingido. Espere um pouco e tente de novo, ou diminua "Páginas ao mesmo tempo".', detail }
  }
  if ((status !== undefined && status >= 500) || is(SERVER)) {
    return { code: 'server', message: 'O servidor da API falhou ou está sobrecarregado. Tente de novo em instantes.', detail }
  }
  if (err instanceof NetworkError || is(NETWORK)) {
    if (isLocalProfile(profile)) {
      return { code: 'network', message: `Nada respondendo em ${profile.baseUrl}. Abra o Ollama (ou o servidor local) e tente de novo.`, detail }
    }
    const where = profile.kind === 'cursor' ? 'ao Cursor' : `em ${profile.baseUrl}`
    return { code: 'network', message: `Não foi possível conectar ${where}. Verifique a internet e a URL base.`, detail }
  }
  return { code: 'other', message: detail }
}

/** Most APIs wrap the reason as {"error":{"message":...}}; the raw body is the fallback. */
function providerMessage(body: string): string {
  try {
    const data = JSON.parse(body) as { error?: { message?: string; metadata?: { raw?: string } } | string; message?: string }
    const error = typeof data.error === 'string' ? data.error : data.error?.message
    const raw = typeof data.error === 'object' ? data.error?.metadata?.raw : undefined
    const message = error ?? data.message
    if (message) return raw ? `${message} (${raw.slice(0, 300)})` : message
  } catch {
    // Not JSON.
  }
  return body.slice(0, 400)
}
