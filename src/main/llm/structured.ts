import type { z } from 'zod/v4'
import type { Result } from '@shared/types'

export interface JsonRequest<S extends z.ZodType> {
  system: string
  user: string
  schema: S
  maxTokens: number
  /** Progress for the card while the call runs, e.g. "Rate limited, retrying..." (Gemini only). */
  onStatus?: (status: string) => void
  /** Aborts the whole exchange when the card no longer wants the answer (superseded or cancelled). */
  signal?: AbortSignal
}

/** What a cancelled exchange answers. Nobody shows it: the card dropped the call. */
export const CANCELLED: Result<never> = { ok: false, error: 'Cancelled' }

/**
 * One provider's wire format for the shared exchange in `askStructured`. `Turn` is a message in
 * the provider's conversation format and `Reply` its raw answer. A transport is built per request,
 * so it already holds the system prompt, schema and token cap.
 */
export interface JsonTransport<Turn, Reply> {
  /** Names the provider in errors: "<name> took too long to answer", "<name> returned an unusable reply (...)". */
  name: string
  /** Budget for the whole exchange: both attempts and every retry the transport makes inside one. */
  deadlineMs: number
  userTurn(text: string): Turn
  /** One model call. A soft failure (a refusal) comes back as an error; a throw goes to `failure`. */
  send(turns: Turn[], signal: AbortSignal): Promise<Result<Reply>>
  /** The reply's text, or why it can't be used before parsing it (cut off at the token cap). */
  text(reply: Reply): Result<string>
  /** The bad reply as a turn for the corrective retry, or null when it is empty (APIs reject empty turns). */
  echo(reply: Reply): Turn | null
  /** A thrown error as a short card message. Only called while the deadline hasn't passed. */
  failure(err: unknown): Result<never>
}

/** A structured-output model behind one LLM_PROVIDER. */
export interface StructuredLlm {
  /** Output-token caps of the two calls. */
  maxTokens: { intent: number; spell: number }
  ask<S extends z.ZodType>(req: JsonRequest<S>): Promise<Result<z.infer<S>>>
}

/** Hands out the provider's model, or a soft error (missing key, unknown LLM_PROVIDER). */
export type LlmSource = () => Result<StructuredLlm>

/**
 * The exchange every provider shares: one call, then exactly one corrective retry when the
 * reply fails to parse or validate. The whole exchange is bounded by the transport's deadline,
 * and every attempt gets the same signal, which `req.signal` (the card cancelling) also aborts.
 */
export async function askStructured<S extends z.ZodType, Turn, Reply>(
  transport: JsonTransport<Turn, Reply>,
  req: { user: string; schema: S; signal?: AbortSignal }
): Promise<Result<z.infer<S>>> {
  const cancelled = req.signal
  if (cancelled?.aborted) return CANCELLED
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), transport.deadlineMs)
  const cancel = (): void => stop.abort()
  cancelled?.addEventListener('abort', cancel, { once: true })
  try {
    const res = await exchange(transport, req, stop.signal)
    return !res.ok && cancelled?.aborted ? CANCELLED : res
  } finally {
    clearTimeout(timer)
    cancelled?.removeEventListener('abort', cancel)
  }
}

async function exchange<S extends z.ZodType, Turn, Reply>(
  t: JsonTransport<Turn, Reply>,
  req: { user: string; schema: S },
  signal: AbortSignal
): Promise<Result<z.infer<S>>> {
  const tooSlow: Result<never> = { ok: false, error: `${t.name} took too long to answer` }

  const call = async (turns: Turn[]): Promise<Result<Reply>> => {
    if (signal.aborted) return tooSlow
    try {
      return await t.send(turns, signal)
    } catch (err) {
      return signal.aborted ? tooSlow : t.failure(err)
    }
  }

  const first = [t.userTurn(req.user)]
  const reply = await call(first)
  if (!reply.ok) return reply
  const parsed = parseReply(t, reply.value, req.schema)
  if (parsed.ok) return parsed

  // Echo the bad reply unchanged (append-only history) unless it was empty.
  const echo = t.echo(reply.value)
  const retry = await call([
    ...first,
    ...(echo ? [echo] : []),
    t.userTurn(
      `Your reply was unusable: ${parsed.error}. Reply again with only the JSON object, exactly matching the schema.`
    )
  ])
  if (!retry.ok) return retry
  const second = parseReply(t, retry.value, req.schema)
  return second.ok ? second : { ok: false, error: `${t.name} returned an unusable reply (${second.error})` }
}

function parseReply<S extends z.ZodType, Turn, Reply>(
  t: JsonTransport<Turn, Reply>,
  reply: Reply,
  schema: S
): Result<z.infer<S>> {
  const text = t.text(reply)
  if (!text.ok) return text
  let json: unknown
  try {
    json = JSON.parse(extractJson(text.value))
  } catch {
    return { ok: false, error: 'it was not valid JSON' }
  }
  const result = schema.safeParse(json)
  if (result.success) return { ok: true, value: result.data }
  const issues = result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ')
  return { ok: false, error: `it did not match the schema (${issues})` }
}

/** Tolerates markdown fences and stray prose around a single JSON object. */
export function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('This operation was aborted', 'AbortError'))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('This operation was aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
