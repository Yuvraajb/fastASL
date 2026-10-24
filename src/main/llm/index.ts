import type { InterpretRequest, IntentResult, LlmProviderName, Result, SpellRequest } from '@shared/types'
import { interpretWith, type ToolSummary } from '../claude/intent'
import { spellSuggestWith } from '../claude/spell'
import { llmSource, type LlmOverrides } from './provider'

export { parseLlmProvider } from './provider'

/**
 * Matches MainServices['interpret'] / MainServices['spellSuggest'] in src/main/ipc.ts. `onStatus`
 * gets progress lines ("Rate limited, retrying..."); `signal` aborts a call the card dropped.
 */
export interface LlmService {
  interpret(
    req: InterpretRequest,
    onStatus?: (status: string) => void,
    signal?: AbortSignal
  ): Promise<Result<IntentResult>>
  spellSuggest(req: SpellRequest, onStatus?: (status: string) => void, signal?: AbortSignal): Promise<Result<string[]>>
}

export interface LlmServiceOptions {
  /** Read on every call so the prompt always lists the agent's current tools. */
  tools: () => ToolSummary[]
  /** parseLlmProvider(LLM_PROVIDER). */
  provider: Result<LlmProviderName>
  overrides?: LlmOverrides
}

/**
 * Intent and spelling on the LLM_PROVIDER from .env. Every provider gets the same prompts and
 * schemas, and its reply goes through the same validation, corrective retry and sanitizing.
 */
export function createLlmService({ tools, provider, overrides }: LlmServiceOptions): LlmService {
  const llm = llmSource(provider, overrides)
  return {
    interpret: (req, onStatus, signal) => interpretWith(req, { tools: tools() }, llm, onStatus, signal),
    spellSuggest: (req, onStatus, signal) => spellSuggestWith(req, llm, onStatus, signal)
  }
}
