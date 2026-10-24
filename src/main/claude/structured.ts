import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { z } from 'zod/v4'
import type { Result } from '@shared/types'
import {
  askStructured,
  type JsonRequest,
  type JsonTransport,
  type LlmSource,
  type StructuredLlm
} from '../llm/structured'
import { MODEL, getClaude, type ClaudeProvider, type CreateMessage } from './client'

export { extractJson, type JsonRequest } from '../llm/structured'

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
  return askStructured(claudeTransport(create, req), req)
}

/** Claude as an LLM_PROVIDER: the caps the Claude path has always used. */
export function claudeLlm(create: CreateMessage): StructuredLlm {
  return { maxTokens: { intent: 1024, spell: 512 }, ask: (req) => askJson(create, req) }
}

/** The Claude client (or its missing-key error) as an LlmSource. */
export function claudeSource(claude: ClaudeProvider = getClaude): LlmSource {
  return () => {
    const client = claude()
    return client.ok ? { ok: true, value: claudeLlm(client.value) } : client
  }
}

function claudeTransport<S extends z.ZodType>(
  create: CreateMessage,
  req: JsonRequest<S>
): JsonTransport<BetaMessageParam, BetaMessage> {
  const { type, schema } = zodOutputFormat(req.schema)
  return {
    name: 'Claude',
    deadlineMs: DEADLINE_MS,
    userTurn: (text) => ({ role: 'user', content: text }),
    async send(messages, signal) {
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
    },
    text: (message) =>
      message.stop_reason === 'max_tokens'
        ? { ok: false, error: 'it was cut off; keep it shorter' }
        : { ok: true, value: replyText(message) },
    echo: (message) => (replyText(message).trim() ? { role: 'assistant', content: message.content } : null),
    failure
  }
}

const replyText = (message: BetaMessage): string =>
  message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

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
