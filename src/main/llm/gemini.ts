import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Schema,
  type ThinkingConfig
} from '@google/genai'
import { z } from 'zod/v4'
import type { Result } from '@shared/types'
import { getKey, missingKeyMessage } from '../env'
import { askStructured, sleep, type JsonRequest, type JsonTransport, type LlmSource, type StructuredLlm } from './structured'

/**
 * Stable, on the free tier, and one of the two models the Gemini docs name for new projects
 * ("3.5 Flash-Lite or 3.8 Flash"). gemini-3.8-flash never answered on the free tier when this was
 * written; GEMINI_MODEL=gemini-3.8-flash picks it once it does.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'
/**
 * The answer's output cap in both calls. `maxOutputTokens` also counts thought tokens, so models
 * that can't think less than LOW get a thinking allowance on top (thinkingAllowance).
 */
export const GEMINI_MAX_TOKENS = 300
/** The whole exchange: the attempts, the corrective retry and every rate-limit wait. */
export const GEMINI_DEADLINE_MS = 30_000
/** One HTTP request, the budget a whole Claude exchange gets, so a stalled model fails as fast. */
export const GEMINI_ATTEMPT_MS = 15_000
/** HTTP 429 retries per exchange (both attempts share them), after the first try. */
export const RATE_LIMIT_RETRIES = 3
/** A rate-limit wait must leave this long before the deadline for the retried request to answer. */
export const RATE_LIMIT_ANSWER_ROOM_MS = 5_000
export const RATE_LIMITED_STATUS = 'Rate limited, retrying...'

const TOO_SLOW: Result<never> = { ok: false, error: 'Gemini took too long to answer' }
const DECLINED: Result<never> = { ok: false, error: 'Gemini declined to answer this one' }

/** The single SDK call this module makes. Injectable so tests run without a key or network. */
export type GenerateContent = (params: GenerateContentParameters) => Promise<GenerateContentResponse>

/** Hands out the Gemini transport, or a soft error when the key is missing. */
export type GeminiProvider = () => Result<GenerateContent>

let cached: { key: string; generate: GenerateContent } | null = null

/**
 * Lazily builds the Gemini client; rebuilt only if the key changes. Never built without a key:
 * the SDK would then fall back to Google Cloud default credentials and probe the metadata server.
 */
export const getGemini: GeminiProvider = () => {
  const key = getKey('GEMINI_API_KEY')
  if (!key) return { ok: false, error: missingKeyMessage('GEMINI_API_KEY'), missingKey: 'GEMINI_API_KEY' }
  if (cached?.key !== key) {
    const ai = new GoogleGenAI({
      apiKey: key,
      // The Developer API (generativelanguage.googleapis.com), whatever GOOGLE_GENAI_USE_VERTEXAI says.
      vertexai: false,
      // 1 attempt = the SDK never retries; the 429 loop below is the only retry.
      httpOptions: { retryOptions: { attempts: 1 } }
    })
    cached = { key, generate: (params) => ai.models.generateContent(params) }
  }
  return { ok: true, value: cached.generate }
}

/** GEMINI_MODEL from .env, or the default. */
export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
}

/** Gemini (or its missing-key error) as an LlmSource. */
export function geminiSource(gemini: GeminiProvider = getGemini, model: () => string = geminiModel): LlmSource {
  return () => {
    const client = gemini()
    return client.ok ? { ok: true, value: geminiLlm(client.value, model()) } : client
  }
}

export function geminiLlm(generate: GenerateContent, model: string): StructuredLlm {
  return {
    maxTokens: { intent: GEMINI_MAX_TOKENS, spell: GEMINI_MAX_TOKENS },
    ask: (req) => askStructured(geminiTransport(generate, model, req), req)
  }
}

function geminiTransport<S extends z.ZodType>(
  generate: GenerateContent,
  model: string,
  req: JsonRequest<S>
): JsonTransport<Content, GenerateContentResponse> {
  const responseSchema = geminiSchema(req.schema)
  // Built right before askStructured starts its deadline, so this is the same deadline.
  const rateLimits = rateLimitBudget()
  // Fresh per call: the SDK may rewrite a request's config.
  const params = (contents: Content[], abortSignal: AbortSignal): GenerateContentParameters => ({
    model,
    contents,
    config: {
      systemInstruction: req.system,
      responseMimeType: 'application/json',
      responseSchema,
      maxOutputTokens: req.maxTokens + thinkingAllowance(model),
      thinkingConfig: thinkingFor(model),
      abortSignal,
      // One generateContent call = one HTTP request (no silent re-send on CONTINUATION).
      automaticContinuation: false
    }
  })
  return {
    name: 'Gemini',
    deadlineMs: GEMINI_DEADLINE_MS,
    userTurn: (text) => ({ role: 'user', parts: [{ text }] }),
    async send(contents, signal) {
      const res = await withRateLimitRetry(
        (attempt) => generate(params(contents, attempt)),
        signal,
        rateLimits,
        req.onStatus
      )
      if (res.promptFeedback?.blockReason) return DECLINED
      const reason = res.candidates?.[0]?.finishReason
      if (reason && BLOCKED.has(reason)) return DECLINED
      return { ok: true, value: res }
    },
    text(res) {
      const candidate = res.candidates?.[0]
      const reason = candidate?.finishReason
      if (reason === FinishReason.MAX_TOKENS) return { ok: false, error: 'it was cut off; keep it shorter' }
      if (reason && reason !== FinishReason.STOP && reason !== FinishReason.FINISH_REASON_UNSPECIFIED) {
        return { ok: false, error: `it stopped early (${reason})` }
      }
      return { ok: true, value: replyText(candidate?.content) }
    },
    // Echoed unchanged: thought signatures must go back as received.
    echo: (res) => {
      const content = res.candidates?.[0]?.content
      return content && replyText(content).trim() ? content : null
    },
    failure: (err) => geminiFailure(err, model)
  }
}

/** Finish reasons that mean the answer was blocked: shown as declined, never retried. */
const BLOCKED = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT
])

/** The text parts of a reply, without thoughts. */
function replyText(content: Content | undefined): string {
  return (content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
}

/** The 429 retries one exchange has left, shared by its attempts, and when its deadline passes. */
export interface RateLimitBudget {
  retriesLeft: number
  deadlineAt: number
}

export const rateLimitBudget = (now: number = Date.now()): RateLimitBudget => ({
  retriesLeft: RATE_LIMIT_RETRIES,
  deadlineAt: now + GEMINI_DEADLINE_MS
})

/**
 * Runs `call` and retries it after HTTP 429 while `budget` allows (nextRateLimitWait), telling
 * the card before each wait. Each try gets its own GEMINI_ATTEMPT_MS timeout and follows `signal`.
 */
export async function withRateLimitRetry<T>(
  call: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  budget: RateLimitBudget,
  onStatus?: (status: string) => void
): Promise<T> {
  for (;;) {
    try {
      return await attempt(call, signal)
    } catch (err) {
      if (!isRateLimited(err) || signal.aborted) throw err
      const wait = nextRateLimitWait(err, budget)
      if (wait === null) throw err
      budget.retriesLeft--
      onStatus?.(RATE_LIMITED_STATUS)
      await sleep(wait, signal)
    }
  }
}

async function attempt<T>(call: (signal: AbortSignal) => Promise<T>, outer: AbortSignal): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), GEMINI_ATTEMPT_MS)
  const relay = (): void => ctl.abort()
  outer.addEventListener('abort', relay, { once: true })
  try {
    return await call(ctl.signal)
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', relay)
  }
}

export const isRateLimited = (err: unknown): err is ApiError => err instanceof ApiError && err.status === 429

/**
 * The wait before the next 429 retry, or null when retrying can't help:
 * - the exchange's 3 retries are used up;
 * - the quota is per day, or 0 for this model (quotaFailure);
 * - the wait would not leave RATE_LIMIT_ANSWER_ROOM_MS before the deadline. A free-tier
 *   per-minute 429 often asks for 20 to 50 s; waiting less only earns another 429.
 * The wait is what the server asked (RetryInfo), or else 1 s, 2 s, 4 s with ±10% jitter.
 */
export function nextRateLimitWait(
  err: ApiError,
  budget: RateLimitBudget,
  now: number = Date.now(),
  random: () => number = Math.random
): number | null {
  if (budget.retriesLeft <= 0) return null
  const quota = quotaFailure(err)
  if (quota.daily || quota.none) return null
  const retry = RATE_LIMIT_RETRIES - budget.retriesLeft
  const wait = retryDelayMs(err) ?? Math.round(1000 * 2 ** retry * (0.9 + 0.2 * random()))
  return now + wait + RATE_LIMIT_ANSWER_ROOM_MS <= budget.deadlineAt ? wait : null
}

const isDetail = (d: unknown, type: string): d is Record<string, unknown> =>
  typeof d === 'object' && d !== null && String((d as { '@type'?: unknown })['@type']).endsWith(type)

/**
 * How long a 429 asks to wait, in ms: google.rpc.RetryInfo.retryDelay ("51s", "0.5s"), or the
 * message's "Please retry in 51.37s" when that is longer (RetryInfo is often whole seconds).
 */
export function retryDelayMs(err: ApiError): number | null {
  const body = apiErrorBody(err)
  const details = Array.isArray(body?.details) ? body.details : []
  const info = details.find((d) => isDetail(d, 'google.rpc.RetryInfo'))
  const delays = [
    /^(\d+(?:\.\d+)?)s$/.exec(String(info?.retryDelay ?? '')),
    /retry in (\d+(?:\.\d+)?)\s*s\b/i.exec(typeof body?.message === 'string' ? body.message : '')
  ].flatMap((m) => (m ? [Math.ceil(Number(m[1]) * 1000)] : []))
  return delays.length ? Math.max(...delays) : null
}

/**
 * What a 429's google.rpc.QuotaFailure says: a per-day quota (resets at midnight Pacific) or a
 * quota of 0 (the model isn't on this key's tier). Retrying in seconds helps with neither.
 */
export function quotaFailure(err: ApiError): { daily: boolean; none: boolean } {
  const body = apiErrorBody(err)
  const details = Array.isArray(body?.details) ? body.details : []
  const violations = details
    .filter((d) => isDetail(d, 'google.rpc.QuotaFailure'))
    .flatMap((d) => (Array.isArray(d.violations) ? (d.violations as Record<string, unknown>[]) : []))
  const message = typeof body?.message === 'string' ? body.message : ''
  return {
    daily: violations.some((v) => /PerDay/i.test(String(v?.quotaId ?? ''))),
    none: violations.some((v) => String(v?.quotaValue ?? '') === '0') || /\blimit: 0\b/.test(message)
  }
}

/** "51 s", or "2 min" from 90 s on. */
function waitText(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  return s < 90 ? `${s} s` : `${Math.ceil(s / 60)} min`
}

/** The card's message for a 429 that wasn't (or no longer is) retried. */
function rateLimitFailure(err: ApiError, model: string): Result<never> {
  const quota = quotaFailure(err)
  if (quota.daily) {
    return { ok: false, error: "Gemini's daily quota is used up. Try tomorrow or set LLM_PROVIDER=claude" }
  }
  if (quota.none) return { ok: false, error: `Gemini has no quota for ${model} on this key. Change GEMINI_MODEL in .env` }
  const delay = retryDelayMs(err)
  return { ok: false, error: `Gemini is rate limited. Try again in ${delay === null ? 'a minute' : waitText(delay)}` }
}

/** The `error` object of an ApiError's JSON body (the SDK puts the body in `message`). */
function apiErrorBody(err: ApiError): { message?: unknown; details?: unknown } | null {
  try {
    const body: unknown = JSON.parse(err.message)
    const error = (body as { error?: unknown } | null)?.error
    return typeof error === 'object' && error !== null ? error : null
  } catch {
    return null
  }
}

function geminiFailure(err: unknown, model: string): Result<never> {
  // A request past GEMINI_ATTEMPT_MS (the whole-exchange deadline is handled before this).
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return TOO_SLOW
  if (err instanceof ApiError) {
    if (err.status === 429) return rateLimitFailure(err, model)
    // No `missingKey`: the key is present but wrong, and "Add GEMINI_API_KEY to .env" would mislead.
    if (err.status === 401 || err.status === 403 || (err.status === 400 && /API_KEY_[A-Z_]+|API key/.test(err.message))) {
      return { ok: false, error: 'Gemini rejected GEMINI_API_KEY. Check .env' }
    }
    if (err.status === 404) return { ok: false, error: `Gemini has no model "${model}". Check GEMINI_MODEL in .env` }
    if (err.status >= 500) return { ok: false, error: 'Gemini is busy right now. Try again in a moment' }
    const message = apiErrorBody(err)?.message
    const detail = typeof message === 'string' ? message : `HTTP ${err.status}`
    return { ok: false, error: `Gemini error: ${detail.length > 160 ? `${detail.slice(0, 157)}...` : detail}` }
  }
  if (err instanceof TypeError && err.message === 'fetch failed') {
    return { ok: false, error: "Can't reach Gemini. Check your connection" }
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/**
 * Thinking off, or as low as the model allows, and how many thought tokens that may still use.
 * Sending both thinkingBudget and thinkingLevel is a 400.
 */
function thinking(model: string): { config?: ThinkingConfig; allowance: number } {
  const id = model.replace(/^models\//, '')
  if (/^gemini-(1\.|2\.0)/.test(id)) return { allowance: 0 } // no thinking
  if (id.startsWith('gemini-2.5-pro')) return { config: { thinkingBudget: 128 }, allowance: 128 } // can't be turned off
  if (id.startsWith('gemini-2.5-')) return { config: { thinkingBudget: 0 }, allowance: 0 } // off
  if (id.includes('flash-lite')) return { config: { thinkingLevel: ThinkingLevel.MINIMAL }, allowance: 0 } // 0 thought tokens live
  // 3.8 Flash refuses MINIMAL; LOW works on every 3.x / 4 model but does think.
  return { config: { thinkingLevel: ThinkingLevel.LOW }, allowance: LOW_THINKING_ALLOWANCE }
}

/** Thought tokens LOW may use before the ~300-token answer, so they don't cut the JSON off. */
export const LOW_THINKING_ALLOWANCE = 1024

export const thinkingFor = (model: string): ThinkingConfig | undefined => thinking(model).config

/** Added to maxOutputTokens, which counts thought tokens too. */
export const thinkingAllowance = (model: string): number => thinking(model).allowance

type JsonSchemaNode = {
  type?: unknown
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  anyOf?: JsonSchemaNode[]
}

/**
 * Gemini's responseSchema (OpenAPI subset) for a zod schema, so the schema the model is held to
 * and the one its reply is validated against are the same. Covers what the fastASL replies use:
 * objects, arrays, strings, numbers, booleans and nullable values.
 */
export function geminiSchema(schema: z.ZodType): Schema {
  return convert(z.toJSONSchema(schema) as JsonSchemaNode)
}

function convert(node: JsonSchemaNode): Schema {
  if (node.anyOf) {
    const values = node.anyOf.filter((n) => n.type !== 'null')
    if (values.length === 1 && node.anyOf.length === 2) return { ...convert(values[0]), nullable: true }
  }
  switch (node.type) {
    case 'string':
      return { type: Type.STRING }
    case 'number':
      return { type: Type.NUMBER }
    case 'integer':
      return { type: Type.INTEGER }
    case 'boolean':
      return { type: Type.BOOLEAN }
    case 'array':
      if (node.items) return { type: Type.ARRAY, items: convert(node.items) }
      break
    case 'object': {
      const keys = Object.keys(node.properties ?? {})
      return {
        type: Type.OBJECT,
        properties: Object.fromEntries(keys.map((key) => [key, convert(node.properties![key])])),
        required: node.required ?? [],
        propertyOrdering: keys
      }
    }
  }
  throw new Error(`geminiSchema: unsupported JSON schema ${JSON.stringify(node)}`)
}
