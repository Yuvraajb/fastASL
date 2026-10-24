import type { ToolOutcome } from './types'

export function fail(text: string): ToolOutcome {
  return { ok: false, text }
}

/** Errors from src/main/mac already carry card-ready messages. */
export function failFrom(err: unknown): ToolOutcome {
  return fail(err instanceof Error ? err.message : String(err))
}
