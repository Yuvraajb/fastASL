import { Check, X } from 'lucide-react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { ActivityBars, Button, ButtonRow, Feed, Header, Notice, OptionList, QuoteBox, SectionTitle, Stack } from '../ui'
import './DidYouMeanView.css'

type DidYouMean = Extract<View, { kind: 'didYouMean' }>
type Props = { view: DidYouMean }

export function DidYouMeanView({ view }: Props): React.JSX.Element {
  return view.variant === 'quote' ? <QuoteVariant view={view} /> : <ListVariant view={view} />
}

/** Reference image 1, panel 12: numbered alternatives, picked by holding up 1-3 fingers. */
function ListVariant({ view }: Props): React.JSX.Element {
  return (
    <Stack>
      <Header view={view} close />
      <Feed aspect={2} />
      <Stack gap={8}>
        <div className="dym__heading">
          <SectionTitle>{view.purpose === 'spell' ? 'Pick a spelling' : 'Did you mean...'}</SectionTitle>
          {view.quote ? <p className="dym__quote">“{view.quote}”</p> : null}
        </div>
        <OptionList options={view.options} />
      </Stack>
      <Notice />
    </Stack>
  )
}

/** Reference image 2, panel 6: confirm the interpreted sentence before it is sent. */
function QuoteVariant({ view }: Props): React.JSX.Element {
  return (
    <Stack>
      <Header view={view} close />
      <SectionTitle>Did you mean?</SectionTitle>
      <QuoteBox
        text={view.quote ?? view.options[0] ?? ''}
        className="dym__panel"
        aside={<Feed variant="thumb" width={84} height={64} />}
      />
      <Notice />
      <ButtonRow>
        <Button icon={Check} iconPosition="leading" stretch="flex" onClick={() => controller.tap('primary')}>
          Yes, send
        </Button>
        <Button variant="secondary" icon={X} iconPosition="leading" stretch="flex" onClick={() => controller.tap('secondary')}>
          Edit
        </Button>
      </ButtonRow>
      <div className="dym__bars">
        <ActivityBars height={16} />
      </div>
    </Stack>
  )
}
