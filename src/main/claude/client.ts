import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Result } from '@shared/types'
import { getKey, missingKeyMessage } from '../env'

export const MODEL = 'claude-sonnet-5-5'
// No per-attempt timeout: askJson's deadline signal bounds every attempt, the SDK's retry sleeps and its own retry.
const MAX_RETRIES = 1

/** The single SDK call this module makes. Injectable so tests run without a key or network. */
export type CreateMessage = (
  params: MessageCreateParamsNonStreaming,
  options: { signal: AbortSignal }
) => Promise<BetaMessage>

/** Hands out the message transport, or a soft error when the key is missing. */
export type ClaudeProvider = () => Result<CreateMessage>

let cached: { key: string; create: CreateMessage } | null = null

/** Lazily builds the Anthropic client; rebuilt only if the key changes. */
export const getClaude: ClaudeProvider = () => {
  const key = getKey('ANTHROPIC_API_KEY')
  if (!key) {
    return { ok: false, error: missingKeyMessage('ANTHROPIC_API_KEY'), missingKey: 'ANTHROPIC_API_KEY' }
  }
  if (cached?.key !== key) {
    const client = new Anthropic({ apiKey: key, maxRetries: MAX_RETRIES })
    cached = { key, create: (params, options) => client.beta.messages.create(params, options) }
  }
  return { ok: true, value: cached.create }
}
