import { HandFist } from 'lucide-react'
import type { View } from '../app/types'
import { Feed, Header, Hint, Notice, Stack, StepsList } from '../ui'
import { visibleSteps } from './visibleSteps'
import './WorkingView.css'

type Props = { view: Extract<View, { kind: 'working' }> }

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
