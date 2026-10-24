import type { InterpretRequest, IntentResult, Result, SpellRequest } from '@shared/types'
import { createLlmService } from '../llm'
import { getClaude, type ClaudeProvider } from './client'
import type { ToolSummary } from './intent'

export type { ToolSummary } from './intent'

/** Matches MainServices['interpret'] / MainServices['spellSuggest'] in src/main/ipc.ts. */
export interface ClaudeService {
  interpret(req: InterpretRequest): Promise<Result<IntentResult>>
  spellSuggest(req: SpellRequest): Promise<Result<string[]>>
}

export interface ClaudeServiceOptions {
  /** Read on every call so the prompt always lists the agent's current tools. */
  tools: () => ToolSummary[]
  claude?: ClaudeProvider
}

/** The LLM service on Claude (LLM_PROVIDER=claude). */
export function createClaudeService({ tools, claude = getClaude }: ClaudeServiceOptions): ClaudeService {
  return createLlmService({ tools, provider: { ok: true, value: 'claude' }, overrides: { claude } })
}
