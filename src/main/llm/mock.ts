import { z } from 'zod/v4'
import { askStructured, type JsonRequest, type JsonTransport, type StructuredLlm } from './structured'

// LLM_PROVIDER=mock: canned, deterministic replies with no network and no key. They go through
// the same JSON parsing, schema validation and sanitizing as a real model's. (FASTASL_MOCK=1 is
// different: it swaps every renderer service, the agent and typing included, for mocks.)

const DEADLINE_MS = 15_000

export const mockLlm: StructuredLlm = {
  maxTokens: { intent: 300, spell: 300, sign: 300 },
  ask: (req) => askStructured(mockTransport(req), req)
}

function mockTransport<S extends z.ZodType>(req: JsonRequest<S>): JsonTransport<string, string> {
  return {
    name: 'The mock model',
    deadlineMs: DEADLINE_MS,
    userTurn: (text) => text,
    send: async () => ({ ok: true, value: JSON.stringify(mockReply(req.user)) }),
    text: (reply) => ({ ok: true, value: reply }),
    echo: (reply) => reply,
    failure: (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** identifySign's canned guess. A real model sees the frames; this one never gets any. */
export const MOCK_SIGN_GUESS = {
  is_sign: true,
  candidates: [
    { gloss: 'HELLO', confidence: 0.62, hands: 1 },
    { gloss: 'THANK YOU', confidence: 0.21, hands: 1 },
    { gloss: 'PLEASE', confidence: 0.09, hands: 1 }
  ]
}

/**
 * The reply to one request JSON: a spelling request has `letters`, a sign request `motion`,
 * an intent request a `draft`.
 */
export function mockReply(user: string): Record<string, unknown> {
  const req = JSON.parse(user) as { letters?: string; draft?: string; intent_prefix?: string | null; motion?: string }
  if (typeof req.motion === 'string') return MOCK_SIGN_GUESS
  if (typeof req.letters === 'string') {
    const lower = req.letters.toLowerCase()
    // The address is dropped unless "@" was spelled, as for a real model.
    return { suggestions: [capitalize(lower), `${lower}.com`, `${lower}@calhacks.io`] }
  }
  const draft = (req.draft ?? '').trim()
  const s = draft.toLowerCase()
  const actions = ['Insert text', 'Send message', 'More options']
  if (s.includes('what') && s.includes('time')) {
    return {
      sentence: 'What time is my next meeting?',
      intent: null,
      alternatives: ['Show my next meeting', 'What time is it?', 'Open Calendar'],
      confidence: 0.5,
      needs_confirmation: false,
      context_actions: []
    }
  }
  if (s.includes('email')) {
    return {
      sentence: `${capitalize(draft)}.`,
      intent: 'Send this email to team@company.com',
      alternatives: [],
      confidence: 0.9,
      needs_confirmation: true,
      context_actions: actions
    }
  }
  if (s.includes('meeting')) {
    return {
      sentence: 'Meeting tomorrow at 3pm.',
      intent: 'Schedule a meeting tomorrow at 3pm with the team',
      alternatives: [],
      confidence: 0.86,
      needs_confirmation: true,
      context_actions: actions
    }
  }
  return {
    sentence: draft ? `${capitalize(draft)}.` : '',
    intent: req.intent_prefix ? `${req.intent_prefix}: ${draft}` : capitalize(draft) || null,
    alternatives: [],
    confidence: 0.8,
    needs_confirmation: false,
    context_actions: ['Insert text', 'More options']
  }
}
