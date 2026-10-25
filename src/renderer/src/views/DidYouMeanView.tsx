import type { View } from '../app/types'
import { Feed, Header, Hint, Notice, OptionList, SectionTitle, Spinner, Stack } from '../ui'
import './DidYouMeanView.css'

type DidYouMean = Extract<View, { kind: 'didYouMean' }>
type Props = { view: DidYouMean }

const fingersHint = (count: number): string => (count > 1 ? `hold up 1–${count} fingers` : 'hold up 1 finger')

/** The list's heading: a learn list asks about the LLM's best guess ("Is this HELLO?"). */
function listTitle(view: DidYouMean): string {
  if (view.purpose === 'spell') return 'Pick a spelling'
  if (view.purpose === 'learn') return `Is this ${view.options[0] ?? 'a sign'}?`
  if (view.purpose === 'meeting') return 'What time?'
  return 'Did you mean...'
}

/** Hint under the list: a learn list says what a fist does (nothing is learned). */
function listHint(view: DidYouMean): string[] | null {
  if (view.purpose === 'learn') return [fingersHint(view.options.length), 'thumbs up = 1', 'fist = no']
  if (view.purpose === 'sign') return null
  if (view.purpose === 'meeting') return [fingersHint(view.options.length), 'fist = cancel']
  return [fingersHint(view.options.length), 'swipe ← edit']
}

/** Reference image 1, panel 12: numbered alternatives, picked by finger count. Swipe left edits what they came from. */
export function DidYouMeanView({ view }: Props): React.JSX.Element {
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
