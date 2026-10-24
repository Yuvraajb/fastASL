import { ArrowRight, HandFist, Mail, Send, ThumbsUp, X } from 'lucide-react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { Button, ButtonRow, Feed, Header, Hint, Notice, Stack } from '../ui'
import { DetailPanel } from './agent-parts'
import './AgentReadyView.css'

type AgentReadyState = Extract<View, { kind: 'agentReady' }>
type Props = { view: AgentReadyState }

const send = (): void => controller.tap('primary')
const change = (): void => controller.tap('secondary')

/** Both variants are hands-only decision points: say which gestures decide. */
const READY_HINT = [
  { icon: ThumbsUp, label: 'send' },
  { icon: HandFist, label: 'cancel' }
]

export function AgentReadyView({ view }: Props): React.JSX.Element {
  return view.variant === 'email' ? <EmailReady view={view} /> : <DefaultReady view={view} />
}

/** Reference image 3, panel 5: the intent in large type, X (change) + "Send to agent". */
function DefaultReady({ view }: Props): React.JSX.Element {
  return (
    <Stack>
      <Header view={view} />
      <Feed aspect={2.2} />
      <p className="agent__intent" title={view.intent}>
        {view.intent}
      </p>
      <Notice />
      <ButtonRow>
        <Button variant="round" icon={X} label="Change" onClick={change} />
        <Button icon={ArrowRight} stretch="flex" onClick={send}>
          Send to agent
        </Button>
      </ButtonRow>
      <Hint items={READY_HINT} />
    </Stack>
  )
}

/**
 * Reference image 2, panel 4 in the ref3 layout language: same header and feed as the
 * default variant, then the recipient box and Send / Change. The header X cancels.
 */
function EmailReady({ view }: Props): React.JSX.Element {
  const recipient = view.target ?? view.intent
  return (
    <Stack>
      <Header view={view} close />
      <Feed aspect={2.2} />
      <DetailPanel
        className="agent__target"
        aside={
          <span className="agent__app" aria-hidden>
            <Mail size={17} strokeWidth={1.9} />
          </span>
        }
      >
        <span className="agent__lead">Send this email to:</span>
        <span className="agent__recipient" title={recipient}>
          {recipient}
        </span>
      </DetailPanel>
      <Notice />
      <Stack gap={8}>
        <Button icon={Send} iconPosition="leading" stretch="fill" onClick={send}>
          Send
        </Button>
        <Button variant="secondary" stretch="fill" onClick={change}>
          Change
        </Button>
      </Stack>
      <Hint items={READY_HINT} />
    </Stack>
  )
}
