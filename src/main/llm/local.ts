import { z } from 'zod/v4'
import type { Result } from '@shared/types'
import { askStructured, type JsonRequest, type JsonTransport, type LlmSource, type StructuredLlm } from './structured'

// LLM_PROVIDER=local: an Ollama server (https://ollama.com) on this Mac, no key.

export const LOCAL_DEFAULT_URL = 'http://127.0.0.1:11434'
/** The 3B instruct model: 2 GB, commonly pulled, and good enough for the intent JSON. */
export const LOCAL_DEFAULT_MODEL = 'llama3.2'
export const LOCAL_MAX_TOKENS = 300
/** Covers a cold model load (llama3.2: 13 s to load, 17 s in all on an M3 Pro) plus a warm corrective retry. */
export const LOCAL_DEADLINE_MS = 30_000
/** Keeps the model loaded between phrases (Ollama's default is 5 minutes). */
const KEEP_ALIVE = '30m'

export interface LocalConfig {
  url: string
  model: string
}

/** LOCAL_LLM_URL / LOCAL_LLM_MODEL from .env, with defaults. Accepts "host:port" without a scheme. */
export function localConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const raw = env.LOCAL_LLM_URL?.trim() || LOCAL_DEFAULT_URL
  const url = (/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).replace(/\/+$/, '')
  return { url, model: env.LOCAL_LLM_MODEL?.trim() || LOCAL_DEFAULT_MODEL }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Base64 images (identifySign's camera frames); only vision models can take them. */
  images?: string[]
}

/** POST /api/chat, non-streaming. */
export interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  stream: false
  /** A JSON schema: Ollama turns it into a grammar the output must follow. */
  format: Record<string, unknown>
  options: { temperature: number; num_predict: number }
  /** Asks thinking models not to think (harmless on the others). */
  think: false
  keep_alive: string
}

export interface OllamaChatResponse {
  model: string
  message: { role: 'assistant'; content: string; thinking?: string }
  done: boolean
  /** 'stop', or 'length' when num_predict was hit. */
  done_reason?: string
}

/** A non-2xx reply. Ollama's body is {"error": "..."}, except for unknown routes (text/plain "404 page not found"). */
export class OllamaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: string | undefined,
    body: string
  ) {
    super(apiError ?? `HTTP ${status}: ${body.slice(0, 120)}`)
    this.name = 'OllamaHttpError'
  }
}

/** The single call this module makes. Injectable so tests run without a server. */
export type LocalChat = (body: OllamaChatRequest, signal: AbortSignal) => Promise<OllamaChatResponse>

/**
 * POST /api/show: the model's capabilities ("completion", "vision", ...), asked before sending
 * images. An older Ollama doesn't list them (undefined): the call then just goes ahead.
 */
export type LocalShow = (model: string, signal: AbortSignal) => Promise<{ capabilities?: string[] }>

export function ollamaShow(baseUrl: string, fetchImpl: typeof fetch = fetch): LocalShow {
  return async (model, signal) => {
    const res = await fetchImpl(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal
    })
    const text = await res.text()
    if (!res.ok) {
      let apiError: string | undefined
      try {
        const parsed = JSON.parse(text) as { error?: unknown } | null
        if (typeof parsed?.error === 'string') apiError = parsed.error
      } catch {
        // not an Ollama server
      }
      throw new OllamaHttpError(res.status, apiError, text)
    }
    const body = JSON.parse(text) as { capabilities?: unknown }
    return Array.isArray(body.capabilities) ? { capabilities: body.capabilities.map(String) } : {}
  }
}

/** identifySign on a model that can't take images. */
export const noVision = (model: string): string => `${model} can't see images. Set LOCAL_LLM_MODEL to a vision model`

/** How long the capability check may take before the call goes ahead anyway. */
const SHOW_TIMEOUT_MS = 5_000

export function ollamaChat(baseUrl: string, fetchImpl: typeof fetch = fetch): LocalChat {
  return async (body, signal) => {
    const res = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
    const text = await res.text()
    if (!res.ok) {
      let apiError: string | undefined
      try {
        const parsed = JSON.parse(text) as { error?: unknown } | null
        if (typeof parsed?.error === 'string') apiError = parsed.error
      } catch {
        // text/plain: LOCAL_LLM_URL is not an Ollama server
      }
      throw new OllamaHttpError(res.status, apiError, text)
    }
    return JSON.parse(text) as OllamaChatResponse
  }
}

/** Ollama at LOCAL_LLM_URL as an LlmSource. Settings are read on every call, like the keys. */
export function localSource(
  chatFor: (url: string) => LocalChat = ollamaChat,
  config: () => LocalConfig = localConfig,
  showFor: (url: string) => LocalShow = ollamaShow
): LlmSource {
  // What /api/show said about each URL and model, so a model without vision is refused at once
  // on later guesses instead of being asked again every time.
  const vision: VisionCache = new Map()
  return () => {
    const cfg = config()
    return { ok: true, value: localLlm(chatFor(cfg.url), cfg, showFor(cfg.url), vision) }
  }
}

/** Whether a model (by "<url> <model>") takes images, as /api/show said. Unknown answers aren't kept. */
export type VisionCache = Map<string, boolean>

export function localLlm(chat: LocalChat, cfg: LocalConfig, show?: LocalShow, vision: VisionCache = new Map()): StructuredLlm {
  return {
    maxTokens: { intent: LOCAL_MAX_TOKENS, spell: LOCAL_MAX_TOKENS, sign: LOCAL_MAX_TOKENS },
    async ask(req) {
      if (req.images?.length && show) {
        const sees = await seesImages(show, cfg, vision, req.signal)
        if (!sees.ok) return sees
      }
      return askStructured(localTransport(chat, cfg, req), req)
    }
  }
}

/**
 * Whether LOCAL_LLM_MODEL takes images, from /api/show. A model that doesn't is a short error
 * before any frames are sent. When Ollama can't say (old server, slow), the call goes ahead and
 * its own error, if any, is mapped by localFailure.
 */
async function seesImages(show: LocalShow, cfg: LocalConfig, cache: VisionCache, signal?: AbortSignal): Promise<Result<void>> {
  const key = `${cfg.url} ${cfg.model}`
  const known = cache.get(key)
  if (known !== undefined) return known ? { ok: true, value: undefined } : { ok: false, error: noVision(cfg.model) }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), SHOW_TIMEOUT_MS)
  const relay = (): void => ctl.abort()
  signal?.addEventListener('abort', relay, { once: true })
  try {
    const { capabilities } = await show(cfg.model, ctl.signal)
    if (!capabilities) return { ok: true, value: undefined }
    const sees = capabilities.includes('vision')
    cache.set(key, sees)
    return sees ? { ok: true, value: undefined } : { ok: false, error: noVision(cfg.model) }
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: 'Cancelled' }
    // Nothing listening or no such model: the same messages the call itself would give.
    if (err instanceof OllamaHttpError && err.status === 404) return localFailure(err, cfg)
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
    if (typeof code === 'string' && UNREACHABLE.has(code)) return localFailure(err, cfg)
    if (err instanceof TypeError && err.message === 'fetch failed') return localFailure(err, cfg)
    return { ok: true, value: undefined }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
}

function localTransport<S extends z.ZodType>(
  chat: LocalChat,
  cfg: LocalConfig,
  req: JsonRequest<S>
): JsonTransport<OllamaMessage, OllamaChatResponse> {
  const format = z.toJSONSchema(req.schema) as Record<string, unknown>
  return {
    name: 'The local model',
    deadlineMs: LOCAL_DEADLINE_MS,
    userTurn: (content, images) => (images ? { role: 'user', content, images: images.map((i) => i.data) } : { role: 'user', content }),
    async send(turns, signal) {
      const value = await chat(
        {
          model: cfg.model,
          messages: [{ role: 'system', content: req.system }, ...turns],
          stream: false,
          format,
          options: { temperature: 0, num_predict: req.maxTokens },
          think: false,
          keep_alive: KEEP_ALIVE
        },
        signal
      )
      return { ok: true, value }
    },
    text(res) {
      const content = res.message?.content ?? ''
      if (res.done_reason === 'length') {
        // Thinking models can spend all of num_predict thinking, leaving no content.
        return { ok: false, error: content.trim() ? 'it was cut off; keep it shorter' : 'it ran out of tokens before answering' }
      }
      return { ok: true, value: content }
    },
    echo: (res) => (res.message?.content?.trim() ? { role: 'assistant', content: res.message.content } : null),
    failure: (err) => localFailure(err, cfg)
  }
}

const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN'])

/** A thrown fetch / HTTP error as a one-line card notice. */
export function localFailure(err: unknown, cfg: LocalConfig): Result<never> {
  if (err instanceof OllamaHttpError) {
    const message = err.apiError ?? ''
    if (err.status === 404 && /^model .* not found/i.test(message)) {
      return { ok: false, error: `Run: ollama pull ${cfg.model}` }
    }
    if (err.status === 404) return { ok: false, error: `No Ollama server at ${cfg.url}. Check LOCAL_LLM_URL in .env` }
    if (err.status === 400 && /\b(image|images|vision|multimodal)\b/i.test(message)) return { ok: false, error: noVision(cfg.model) }
    if (err.status === 400 && /does not support (chat|thinking)/i.test(message)) {
      return { ok: false, error: `${cfg.model} can't do this. Set LOCAL_LLM_MODEL to a chat model, e.g. ${LOCAL_DEFAULT_MODEL}` }
    }
    if (err.status === 503 || err.status === 429) return { ok: false, error: 'Ollama is busy right now. Try again in a moment' }
    return { ok: false, error: `Ollama error: ${message || `HTTP ${err.status}`}` }
  }
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  if (code === 'ERR_INVALID_URL') return { ok: false, error: 'LOCAL_LLM_URL in .env is not a valid URL' }
  // undici's "fetch failed": connection refused, unknown host, blocked port...
  if ((typeof code === 'string' && UNREACHABLE.has(code)) || (err instanceof TypeError && err.message === 'fetch failed')) {
    return { ok: false, error: 'Start Ollama (ollama serve) or set LOCAL_LLM_URL' }
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { ok: false, error: 'The local model took too long to answer' }
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}
