import type { CustomGesture, ShortcutRunResult, ToolCallRecord } from '@shared/types'
import type { AgentService, Emit } from './agentService'
import type { RunOutcome } from './types'

export interface ShortcutDeps {
  agent: Pick<AgentService, 'replay' | 'start'>
  getGestures(): CustomGesture[]
  saveGestures(gestures: CustomGesture[]): void
}

function failure(title: string, subtitle: string, compiled: boolean, durationMs: number): ShortcutRunResult {
  return { ok: false, title, subtitle, compiled, durationMs }
}

function toResult(outcome: RunOutcome, compiled: boolean, durationMs: number): ShortcutRunResult {
  switch (outcome.kind) {
    case 'done': {
      const { title, subtitle } = outcome.result
      return { ok: outcome.complete, title, subtitle, compiled, durationMs }
    }
    case 'stopped':
      return failure('Stopped', 'The shortcut was stopped', compiled, durationMs)
    case 'failed':
      return failure('Shortcut failed', outcome.message, compiled, durationMs)
  }
}

function recompile(deps: ShortcutDeps, gestureId: string, calls: ToolCallRecord[]): void {
  try {
    deps.saveGestures(deps.getGestures().map((g) => (g.id === gestureId ? { ...g, compiled: calls } : g)))
  } catch (error) {
    console.warn('[shortcuts] could not save the compiled sequence:', error)
  }
}

/**
 * Runs a gesture shortcut. A compiled sequence replays its exact tool calls with
 * no model (write steps still ask for confirmation). Without one, or when a step
 * fails, the agent does the task, and if it did the whole task its successful
 * calls become the new compiled sequence.
 */
export async function runShortcut(gestureId: string, emit: Emit, deps: ShortcutDeps): Promise<ShortcutRunResult> {
  const startedAt = performance.now()
  const elapsed = (): number => Math.round(performance.now() - startedAt)
  const gesture = deps.getGestures().find((g) => g.id === gestureId)
  if (!gesture) return failure('Unknown gesture', 'This shortcut no longer exists', false, elapsed())

  let replayError: string | undefined
  if (gesture.compiled?.length) {
    const replayed = await deps.agent.replay(gesture.task, gesture.compiled, emit)
    if (replayed.kind !== 'failed') return toResult(replayed, true, elapsed())
    replayError = replayed.message
  }

  const started = await deps.agent.start({ intent: gesture.task, sentence: gesture.task, frontmost: null }, emit)
  if (!started.ok) {
    // When a replay failed, its reason (e.g. a missing macOS permission) matters more than the agent being unavailable.
    return failure('Shortcut failed', replayError ?? started.error, false, elapsed())
  }
  const outcome = await started.value.completion
  // A declined or half-finished run would compile into a shortcut that silently does only part of the task.
  if (outcome.kind === 'done' && outcome.complete) recompile(deps, gesture.id, outcome.succeeded)
  return toResult(outcome, false, elapsed())
}
