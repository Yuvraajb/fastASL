import type { AgentStep } from '@shared/types'

const STARTING: AgentStep[] = [{ id: 'starting', label: 'Starting agent...', status: 'current' }]
const MAX_STEPS = 5

/**
 * Keeps Working's list short on long runs: a window of steps around the one running now, or the
 * latest. A step that failed earlier (the agent then retried) never holds the window back.
 */
export function visibleSteps(steps: AgentStep[]): AgentStep[] {
  if (!steps.length) return STARTING
  if (steps.length <= MAX_STEPS) return steps
  const current = steps.findLastIndex((s) => s.status === 'current')
  const focus = current === -1 ? steps.length - 1 : current
  const start = Math.min(Math.max(0, focus - 2), steps.length - MAX_STEPS)
  return steps.slice(start, start + MAX_STEPS)
}
