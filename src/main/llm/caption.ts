import type { Result } from '@shared/types'
import { localConfig, ollamaChat, type LocalChat, type LocalConfig } from './local'

/**
 * The caption camera's English: the signed glosses (in ASL order) as one natural sentence, from
 * the local Ollama model (LOCAL_LLM_URL / LOCAL_LLM_MODEL, llama3.2 by default) whatever
 * LLM_PROVIDER is. It answers in 0.1 to 0.7 s once loaded, costs nothing, and the call stays on
 * the Mac. A small model also guesses wrong (YES came back as "I'm okay."), so a sentence that
 * leaves out a signed word is refused and the caption keeps the glosses.
 */
export const CAPTION_SYSTEM = [
  'You turn ASL glosses into natural English captions for a video call.',
  'The glosses are signs in ASL order: time words come first, then the topic, and question words often come last.',
  'Write what the signer is saying as one natural English sentence, in their own voice (first person).',
  'Keep the meaning and every signed word. Do not add names, facts or details that were not signed.',
  'A short run of capital letters (KC, JB) is a person\'s name or initials: keep it exactly as written, never read it as a place or an abbreviation.',
  'Without a time sign (YESTERDAY, TOMORROW, ...), use the present tense. Add a question mark for questions.',
  'Reply with JSON: {"sentence": "..."}.'
].join('\n')

/** Worked examples, sent as earlier turns. */
const SHOTS: [string, string][] = [
  ['TOMORROW MEETING WHAT TIME', 'What time is the meeting tomorrow?'],
  ['ME STORE GO YESTERDAY', 'I went to the store yesterday.'],
  ['YOU NAME WHAT', "What's your name?"],
  ['YES PLEASE', 'Yes, please.'],
  ['MEETING KC TOMORROW', 'Meeting with KC tomorrow.'],
  ['HELLO KC', 'Hello, KC.']
]

const FORMAT = {
  type: 'object',
  properties: { sentence: { type: 'string' } },
  required: ['sentence']
}

/** Covers a cold model load (llama3.2 takes about 13 s); a warm answer takes well under 1 s. */
export const CAPTION_DEADLINE_MS = 20_000
const MAX_SENTENCE = 200

/** Other ways a sentence may say a sign. A sign not listed must appear as itself (or a longer form: call, calling). */
const SAYS: Record<string, string[]> = {
  hello: ['hello', 'hi', 'hey'],
  mom: ['mom', 'mother', 'mum'],
  dad: ['dad', 'father'],
  yes: ['yes', 'yeah', 'yep'],
  no: ['no', 'not', 'nope'],
  'thank you': ['thank', 'thanks'],
  you: ['you']
}
/** The sentence speaks as the signer, so these need not appear word for word. */
const FREE = new Set(['me', 'i', 'my', 'mine', 'myself'])

/** Whether the sentence still says every signed word (by a longer form or a listed synonym). */
export function keepsEverySign(glosses: readonly string[], sentence: string): boolean {
  const words = sentence.toLowerCase().match(/[a-z0-9']+/g) ?? []
  return glosses.every((gloss) => {
    const sign = gloss.toLowerCase().trim()
    if (FREE.has(sign)) return true
    const forms = SAYS[sign] ?? [sign]
    return forms.some((form) => words.some((w) => w.startsWith(form)))
  })
}

export interface CaptionDeps {
  chat: (url: string) => LocalChat
  config: () => LocalConfig
}

const defaultDeps: CaptionDeps = { chat: ollamaChat, config: localConfig }

/** The glosses as one English sentence, or an error (the caption then keeps the glosses). */
export async function translateGlosses(glosses: readonly string[], deps: CaptionDeps = defaultDeps): Promise<Result<string>> {
  const signs = glosses.map((g) => g.trim()).filter(Boolean)
  if (!signs.length) return { ok: false, error: 'nothing signed' }
  const cfg = deps.config()
  const messages = [
    { role: 'system' as const, content: CAPTION_SYSTEM },
    ...SHOTS.flatMap(([q, a]) => [
      { role: 'user' as const, content: q },
      { role: 'assistant' as const, content: JSON.stringify({ sentence: a }) }
    ]),
    { role: 'user' as const, content: signs.map((s) => s.toUpperCase()).join(' ') }
  ]
  try {
    const res = await deps.chat(cfg.url)(
      {
        model: cfg.model,
        messages,
        stream: false,
        format: FORMAT,
        options: { temperature: 0, num_predict: 60 },
        think: false,
        keep_alive: '30m'
      },
      AbortSignal.timeout(CAPTION_DEADLINE_MS)
    )
    const parsed = JSON.parse(res.message.content) as { sentence?: unknown }
    const sentence = typeof parsed.sentence === 'string' ? parsed.sentence.replace(/\s+/g, ' ').trim() : ''
    if (!sentence || sentence.length > MAX_SENTENCE) return { ok: false, error: 'no sentence' }
    if (!keepsEverySign(signs, sentence)) return { ok: false, error: `left out a sign: "${sentence}"` }
    return { ok: true, value: sentence }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
