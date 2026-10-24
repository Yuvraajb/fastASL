import type { InterpretRequest, IntentResult, Result, SpellRequest } from '@shared/types'
import { getClaude, type ClaudeProvider } from './client'
import { interpret, type ToolSummary } from './intent'
import { spellSuggest } from './spell'

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

export function createClaudeService({ tools, claude = getClaude }: ClaudeServiceOptions): ClaudeService {
  return {
    interpret: (req) => interpret(req, { tools: tools() }, claude),
    spellSuggest: (req) => spellSuggest(req, claude)
  }
}
