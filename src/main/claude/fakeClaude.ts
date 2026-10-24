// Test double for the Anthropic transport. Imported only by *.test.ts files.
import type {
  BetaMessage,
  BetaStopReason,
  MessageCreateParamsNonStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ClaudeProvider } from './client'

type FakeText = string | { text: string; stop_reason: BetaStopReason }

/** A canned reply, an error to throw, or a function for timing-sensitive replies (it gets the request's signal). */
export type FakeReply = FakeText | Error | ((signal: AbortSignal) => Promise<FakeText>)

export function fakeClaude(...replies: FakeReply[]): {
  provider: ClaudeProvider
  calls: MessageCreateParamsNonStreaming[]
  signals: AbortSignal[]
} {
  const calls: MessageCreateParamsNonStreaming[] = []
  const signals: AbortSignal[] = []
  const queue = [...replies]
  const provider: ClaudeProvider = () => ({
    ok: true,
    value: async (params, { signal }) => {
      calls.push(params)
      signals.push(signal)
      const next = queue.shift()
      if (next === undefined) throw new Error('fakeClaude: no reply queued')
      if (next instanceof Error) throw next
      const reply = typeof next === 'function' ? await next(signal) : next
      const { text, stop_reason } =
        typeof reply === 'string' ? { text: reply, stop_reason: 'end_turn' as const } : reply
      return {
        id: `msg_${calls.length}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text, citations: null }],
        stop_reason,
        stop_sequence: null
      } as unknown as BetaMessage
    }
  })
  return { provider, calls, signals }
}

/** The text of the last user message in a recorded call. */
export function lastUserText(params: MessageCreateParamsNonStreaming): string {
  const last = params.messages[params.messages.length - 1]
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
}

/** The system prompt text of a recorded call. */
export function systemText(params: MessageCreateParamsNonStreaming): string {
  return typeof params.system === 'string' ? params.system : (params.system ?? []).map((b) => b.text).join('\n')
}
