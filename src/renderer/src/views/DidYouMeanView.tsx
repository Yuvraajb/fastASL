import { Check, X } from 'lucide-react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import {
  ActivityBars,
  Button,
  ButtonRow,
  Feed,
  Header,
  Hint,
  Notice,
  OptionList,
  QuoteBox,
  SectionTitle,
  Spinner,
  Stack
} from '../ui'
import './DidYouMeanView.css'

type DidYouMean = Extract<View, { kind: 'didYouMean' }>
type Props = { view: DidYouMean }

export function DidYouMeanView({ view }: Props): React.JSX.Element {
  return view.variant === 'quote' ? <QuoteVariant view={view} /> : <ListVariant view={view} />
}

const fingersHint = (count: number): string => (count > 1 ? `hold up 1–${count} fingers` : 'hold up 1 finger')

/** The list's heading: a learn list asks about the LLM's best guess ("Is this HELLO?"). */
function listTitle(view: DidYouMean): string {
  if (view.purpose === 'spell') return 'Pick a spelling'
  if (view.purpose === 'learn') return `Is this ${view.options[0] ?? 'a sign'}?`
  return 'Did you mean...'
}

/** Hint under the list: a learn list says what a fist does (nothing is learned). */
function listHint(view: DidYouMean): string[] | null {
  if (view.purpose === 'learn') return [fingersHint(view.options.length), 'thumbs up = 1', 'fist = no']
  if (view.purpose === 'sign') return null
  return [fingersHint(view.options.length), 'swipe ← edit']
}

/** Reference image 1, panel 12: numbered alternatives, picked by finger count. Swipe left edits what they came from. */
function ListVariant({ view }: Props): React.JSX.Element {
  const hint = listHint(view)
  return (
    <Stack>
      <Header view={view} close />
      <Feed aspect={2} />
      <Stack gap={8}>
        <div className="dym__heading">
          <SectionTitle>{listTitle(view)}</SectionTitle>
          {view.quote ? <p className="dym__quote">“{view.quote}”</p> : null}
        </div>
        <OptionList options={view.options} />
        {view.pending ? (
          <p className="dym__pending">
            <Spinner size={12} />
            Finding spellings...
          </p>
        ) : null}
      </Stack>
      <Notice />
      {hint ? <Hint items={hint} /> : null}
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
