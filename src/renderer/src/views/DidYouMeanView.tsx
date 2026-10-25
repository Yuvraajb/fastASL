import type { View } from '../app/types'
import { Feed, Header, Hint, Notice, OptionList, SectionTitle, Spinner, Stack } from '../ui'
import './DidYouMeanView.css'

type DidYouMean = Extract<View, { kind: 'didYouMean' }>
type Props = { view: DidYouMean }

const fingersHint = (count: number): string => (count > 1 ? `hold up 1–${count} fingers` : 'hold up 1 finger')

/** The list's heading. */
function listTitle(view: DidYouMean): string {
  if (view.purpose === 'spell') return 'Pick a spelling'
  return 'Did you mean...'
}

/** Hint under the list. */
function listHint(view: DidYouMean): string[] | null {
  if (view.purpose === 'sign') return null
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
