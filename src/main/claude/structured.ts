import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { z } from 'zod/v4'
import type { Result } from '@shared/types'
import { MODEL, type CreateMessage } from './client'

export interface JsonRequest<S extends z.ZodType> {
  system: string
  user: string
  schema: S
  maxTokens: number
}

/** Budget for one askJson call, covering SDK retries, their backoff sleeps and the corrective retry. */
const DEADLINE_MS = 15_000
const TOO_SLOW: Result<never> = { ok: false, error: 'Claude took too long to answer' }

/**
 * One low-latency structured-output call: strict JSON schema, no extended thinking,
 * low effort. A reply that fails to parse or validate gets exactly one corrective retry.
 * The whole exchange is bounded by DEADLINE_MS.
 */
export async function askJson<S extends z.ZodType>(
  create: CreateMessage,
  req: JsonRequest<S>
): Promise<Result<z.infer<S>>> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS)
  try {
    return await exchange(create, req, deadline.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function exchange<S extends z.ZodType>(
  create: CreateMessage,
  req: JsonRequest<S>,
  signal: AbortSignal
): Promise<Result<z.infer<S>>> {
  const { type, schema } = zodOutputFormat(req.schema)

  const call = async (messages: BetaMessageParam[]): Promise<Result<BetaMessage>> => {
    if (signal.aborted) return TOO_SLOW
    try {
      const message = await create(
        {
          model: MODEL,
          max_tokens: req.maxTokens,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages,
          thinking: { type: 'between_tools' },
          output_config: { effort: 'low', format: { type, schema } },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default'
        },
        { signal }
      )
      if (message.stop_reason === 'refusal') return { ok: false, error: 'Claude declined to answer this one' }
      return { ok: true, value: message }
    } catch (err) {
      return signal.aborted ? TOO_SLOW : failure(err)
    }
  }

  const first: BetaMessageParam[] = [{ role: 'user', content: req.user }]
  const reply = await call(first)
  if (!reply.ok) return reply
  const parsed = parseReply(reply.value, req.schema)
  if (parsed.ok) return parsed

  // Echo the bad reply unchanged (append-only history) unless it was empty, which the API rejects.
  const echo: BetaMessageParam[] = replyText(reply.value).trim()
    ? [{ role: 'assistant', content: reply.value.content }]
    : []
  const retry = await call([
    ...first,
    ...echo,
    {
      role: 'user',
      content: `Your reply was unusable: ${parsed.error}. Reply again with only the JSON object, exactly matching the schema.`
    }
  ])
  if (!retry.ok) return retry
  const second = parseReply(retry.value, req.schema)
  return second.ok ? second : { ok: false, error: `Claude returned an unusable reply (${second.error})` }
}

function parseReply<S extends z.ZodType>(message: BetaMessage, schema: S): Result<z.infer<S>> {
  if (message.stop_reason === 'max_tokens') return { ok: false, error: 'it was cut off; keep it shorter' }
  let json: unknown
  try {
    json = JSON.parse(extractJson(replyText(message)))
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

const replyText = (message: BetaMessage): string =>
  message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

/** Tolerates markdown fences and stray prose around a single JSON object. */
export function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

function failure(err: unknown): Result<never> {
  if (err instanceof Anthropic.AuthenticationError) {
    // No `missingKey`: the key is present but wrong, and "Add ANTHROPIC_API_KEY to .env" would mislead.
    return { ok: false, error: 'Claude rejected ANTHROPIC_API_KEY. Check .env' }
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { ok: false, error: 'Claude is busy right now. Try again in a moment' }
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return TOO_SLOW
  if (err instanceof Anthropic.APIConnectionError) {
    return { ok: false, error: "Can't reach Claude. Check your connection" }
  }
  if (err instanceof Anthropic.APIError) return { ok: false, error: `Claude error: ${err.message}` }
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}
