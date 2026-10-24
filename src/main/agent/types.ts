import type { ClientPermissionHandler, DroidStreamMessage, DroidTool } from '@factory/droid-sdk/node'
import type { AgentResult, ToolCallRecord } from '@shared/types'
import type { ToolDef, ToolOutcome } from '../tools/types'

/** The slice of a Droid session the agent uses; the real one is `DroidSession`, tests use a fake. */
export interface DroidSessionLike {
  stream(prompt: string): AsyncIterable<DroidStreamMessage>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export interface SessionOptions {
  apiKey: string
  execPath: string
  cwd: string
  /** Appended to Droid's own system prompt. */
  systemPrompt: string
  /** The fastasl tools, served to Droid by an in-process MCP server. */
  tools: DroidTool[]
  permissionHandler: ClientPermissionHandler
}

export type SessionFactory = (options: SessionOptions) => Promise<DroidSessionLike>

/** Runs one tool by name with already-recorded args (used to replay compiled shortcuts). */
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>

/** A tool call that actually executed, with the outcome the tool itself produced. */
export interface RecordedCall {
  def: ToolDef
  record: ToolCallRecord
  outcome: ToolOutcome
}

/** What a run needs to expose to the code that executes tools. */
export interface RunContext {
  readonly stopped: boolean
  /** Shows a Working step; call the returned function once the step has settled. */
  beginStep(label: string): (status: 'done' | 'error') => void
  record(call: RecordedCall): void
  /** Consumes one user approval for a write tool; false when the user approved none. */
  takeApproval(tool: string): boolean
}

export type RunOutcome =
  | {
      kind: 'done'
      result: AgentResult
      /** The whole task got done; only then may a shortcut compile `succeeded`. */
      complete: boolean
      /** The calls that worked, in order. */
      succeeded: ToolCallRecord[]
    }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' }
