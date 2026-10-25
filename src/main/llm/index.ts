import type {
  IdentifySignRequest,
  InterpretRequest,
  IntentResult,
  LlmProviderName,
  Result,
  SignGuess,
  SpellRequest
} from '@shared/types'
import { interpretWith, type ToolSummary } from '../claude/intent'
import { identifySignWith } from '../claude/sign'
import { spellSuggestWith } from '../claude/spell'
import { llmSource, type LlmOverrides } from './provider'

export { parseLlmProvider } from './provider'

/**
 * Matches MainServices['interpret'] / ['spellSuggest'] / ['identifySign'] in src/main/ipc.ts. `onStatus`
 * gets progress lines ("Rate limited, retrying..."); `signal` aborts a call the card dropped.
 */
export interface LlmService {
  interpret(
    req: InterpretRequest,
    onStatus?: (status: string) => void,
    signal?: AbortSignal
  ): Promise<Result<IntentResult>>
  spellSuggest(req: SpellRequest, onStatus?: (status: string) => void, signal?: AbortSignal): Promise<Result<string[]>>
  /** Guess, confirm, learn: names a movement the local recognizer didn't know, from camera frames. */
  identifySign(
    req: IdentifySignRequest,
    onStatus?: (status: string) => void,
    signal?: AbortSignal
  ): Promise<Result<SignGuess>>
}

export interface LlmServiceOptions {
  /** Read on every call so the prompt always lists the agent's current tools. */
  tools: () => ToolSummary[]
  /** parseLlmProvider(LLM_PROVIDER). */
  provider: Result<LlmProviderName>
  overrides?: LlmOverrides
}

/**
 * Intent, spelling and sign guesses on the LLM_PROVIDER from .env. Every provider gets the same prompts and
 * schemas, and its reply goes through the same validation, corrective retry and sanitizing.
 */
export function createLlmService({ tools, provider, overrides }: LlmServiceOptions): LlmService {
  if (provider.ok && provider.value === 'droid') return droidLlmService()
  const llm = llmSource(provider, overrides)
  const vision = llmSource(provider, overrides, 'vision')
  return {
    interpret: (req, onStatus, signal) => interpretWith(req, { tools: tools() }, llm, onStatus, signal),
    spellSuggest: (req, onStatus, signal) => spellSuggestWith(req, llm, onStatus, signal),
    identifySign: (req, onStatus, signal) => identifySignWith(req, vision, onStatus, signal)
  }
}

/**
 * LLM_PROVIDER=droid: no model besides the Factory Droid agent. The signed words go to the agent
 * as they are (ASL glosses in signing order) and it reads them itself, one hop instead of two. No
 * spelling suggestions, and no sign guesses (they need a vision model).
 */
/** The signed tokens as words: a run of single capital letters (D, W) is one spelled word ("DW"), not two. */
export function joinLetters(tokens: readonly string[]): string {
  const words: string[] = []
  let last: 'letter' | 'word' | null = null
  for (const t of tokens) {
    const isLetter = /^[A-Z]$/.test(t)
    if (isLetter && last === 'letter') words[words.length - 1] += t
    else words.push(t)
    last = isLetter ? 'letter' : 'word'
  }
  return words.join(' ')
}

export function droidLlmService(): LlmService {
  return {
    async interpret(req) {
      // CALL D W must reach the direct-call matcher as "Call DW" (initials as one nickname).
      const words = joinLetters(req.tokens).trim() || req.sentence.trim()
      if (!words && !req.intentPrefix) return { ok: false, error: 'Nothing signed yet' }
      const glosses = req.intentPrefix ? `${req.intentPrefix}: ${words}` : words
      const sentence = words ? words.charAt(0).toUpperCase() + words.slice(1) : glosses
      return {
        ok: true,
        value: {
          sentence,
          intent: req.mode === 'command' ? `(ASL glosses, in signing order) ${glosses}` : null,
          alternatives: [],
          confidence: 0.9,
          needs_confirmation: false,
          context_actions: []
        }
      }
    },
    spellSuggest: async () => ({ ok: true, value: [] }),
    identifySign: async () => ({ ok: false, error: 'Sign guesses need a vision model: set LLM_PROVIDER=gemini or claude' })
  }
}

