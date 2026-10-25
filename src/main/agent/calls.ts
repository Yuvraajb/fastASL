import { z } from 'zod'
import type { AgentResult, ConfirmDetails } from '@shared/types'
import type { ToolDef, ToolOutcome } from '../tools/types'
import type { RecordedCall, RunContext } from './types'

export type ToolArgs = Record<string, unknown>

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validates args against the tool's schema (also applies defaults), or returns undefined. */
export function parseArgs(def: ToolDef, args: unknown): ToolArgs | undefined {
  const parsed = z.object(def.schema).safeParse(args)
  return parsed.success ? parsed.data : undefined
}

const describeValue = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

/** The Confirm card for a write call; a generic card when the tool has none (or its builder fails). */
export function confirmDetailsFor(def: ToolDef, args: ToolArgs): ConfirmDetails {
  try {
    const details = def.confirmDetails?.(args)
    if (details) return details
  } catch (error) {
    console.warn(`[agent] confirmDetails failed for ${def.name}:`, error)
  }
  return {
    kind: 'generic',
    title: def.stepLabel(args),
    lines: Object.entries(args).map(([key, value]) => `${key}: ${describeValue(value)}`)
  }
}

/** Runs one tool call as a Working step and records what the tool itself reported. Never throws. */
export async function performCall(
  ctx: RunContext,
  def: ToolDef,
  args: ToolArgs,
  exec: () => Promise<ToolOutcome>
): Promise<ToolOutcome> {
  const settle = ctx.beginStep(def.stepLabel(args))
  const outcome = await Promise.resolve()
    .then(exec)
    .catch((error: unknown): ToolOutcome => ({ ok: false, text: errorText(error) }))
  ctx.record({ def, outcome, record: { tool: def.name, args, ok: outcome.ok, result: outcome.text } })
  settle(outcome.ok ? 'done' : 'error')
  return outcome
}

function firstLine(text: string, max = 90): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Whether the calls did the whole task: nothing was declined, the last call
 * worked, and so did the last attempt of every write tool (a write the model
 * retried successfully counts).
 */
export function callsComplete(calls: readonly RecordedCall[], declined: boolean): boolean {
  if (declined || !calls.at(-1)?.outcome.ok) return false
  const lastWrite = new Map<string, boolean>()
  for (const { def, outcome } of calls) if (def.risk === 'write') lastWrite.set(def.name, outcome.ok)
  return [...lastWrite.values()].every(Boolean)
}

export interface Ending {
  /** The run did the whole task (see callsComplete; an agent turn must also have finished normally). */
  complete: boolean
  declined: boolean
  /** The user stopped the run (it is reported only when a write had gone through). */
  stopped?: boolean
  /** Why an agent turn broke off, when it did. */
  error?: string
  /** The model's final text, from a turn that finished normally (see AgentResult.reply). */
  reply?: string
}

/** Longest model reply passed to the card; the prompt asks for one or two sentences. */
const MAX_REPLY = 400

/**
 * The model's reply as card text: plain words on one line. Markdown emphasis, code marks and
 * list bullets are dropped, whitespace (newlines too) collapses, and a runaway reply is cut.
 */
export function cleanReply(text: string | undefined): string | undefined {
  if (!text) return undefined
  const plain = text
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return undefined
  return plain.length > MAX_REPLY ? `${plain.slice(0, MAX_REPLY - 1).trimEnd()}…` : plain
}

/** Why a run stopped short of the task, for the result's subtitle. */
function shortfall(calls: readonly RecordedCall[], { declined, stopped, error }: Ending, wroteSomething: boolean): string {
  if (declined) return wroteSomething ? 'You cancelled the rest' : 'You cancelled it'
  if (stopped) return wroteSomething ? 'You stopped the rest' : 'You stopped it'
  const failed = calls.filter((c) => !c.outcome.ok).at(-1)
  if (failed) return firstLine(failed.outcome.text)
  if (error) return error
  return calls.length > 0 ? "The agent didn't finish" : "The agent didn't run any action"
}

/**
 * The result card, its title and subtitle built only from tool outcomes. A write
 * that ran is always the headline (so nobody repeats it); a finished task shows
 * its last successful call; otherwise the subtitle says why the task stopped
 * short. The model's own text rides along as `reply` only from a turn that
 * finished normally: never after a decline or a stop, where it could describe
 * something that didn't happen.
 */
export function summarize(calls: readonly RecordedCall[], ending: Ending): AgentResult {
  const evidence = calls.map((c) => c.record)
  const ok = calls.filter((c) => c.outcome.ok)
  const write = ok.filter((c) => c.def.risk === 'write').at(-1)
  const reply = ending.declined || ending.stopped || ending.error !== undefined ? undefined : cleanReply(ending.reply)
  const withReply = reply ? { reply } : {}
  // Lookups made for a task the user then cancelled are not worth a headline.
  const best = write ?? (ending.declined ? undefined : ok.at(-1))
  if (!best) return { title: 'Nothing was done', subtitle: shortfall(calls, ending, false), evidence, ...withReply }
  const { title, subtitle, text, view } = best.outcome
  return {
    title: title ?? firstLine(text),
    subtitle: ending.complete ? (subtitle ?? (title ? firstLine(text) : '')) : shortfall(calls, ending, !!write),
    evidence,
    ...(view && { view }),
    ...withReply
  }
}
