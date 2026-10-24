import { HandFist } from 'lucide-react'
import type { AgentStep } from '@shared/types'
import type { View } from '../app/types'
import { Feed, Header, Hint, Notice, Stack, StepsList } from '../ui'
import './WorkingView.css'

type Props = { view: Extract<View, { kind: 'working' }> }

const STARTING: AgentStep[] = [{ id: 'starting', label: 'Starting agent...', status: 'current' }]
const MAX_STEPS = 5

/** Keeps the list short on long runs: a window of steps around the first unfinished one. */
function visibleSteps(steps: AgentStep[]): AgentStep[] {
  if (!steps.length) return STARTING
  if (steps.length <= MAX_STEPS) return steps
  const active = steps.findIndex((s) => s.status !== 'done')
  const focus = active === -1 ? steps.length - 1 : active
  const start = Math.min(Math.max(0, focus - 2), steps.length - MAX_STEPS)
  return steps.slice(start, start + MAX_STEPS)
}

/** Reference image 3, panel 6: header with X (stops the agent), feed, live step list. */
export function WorkingView({ view }: Props): React.JSX.Element {
  return (
    <Stack>
      <Header view={view} close />
      <Feed aspect={1.85} />
      <StepsList steps={visibleSteps(view.steps)} className="working__steps" />
      <Notice />
      <Hint items={[{ icon: HandFist, label: 'fist to stop' }]} />
    </Stack>
  )
}
