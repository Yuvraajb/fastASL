import { X } from 'lucide-react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { ActivityBars, Feed, Footer, Header, Notice, Panel, Stack } from '../ui'
import './DictationView.css'

type Props = { view: Extract<View, { kind: 'dictation' }> }

/** Reference image 1, panel 10: signs are typed into the focused app as they are recognized. */
export function DictationView({ view }: Props): React.JSX.Element {
  const text = view.text.trimEnd()
  // Keep the caret on the same line as the last word.
  const split = text.lastIndexOf(' ') + 1
  const head = text.slice(0, split)
  const tail = text.slice(split)
  return (
    <Stack>
      <Header view={view} />
      <Feed recording />
      {/* Clear on the left, bars centered on the card (ref1-10). */}
      <div className="dictation__status">
        <button
          type="button"
          className="dictation__clear"
          aria-label="Clear dictated text"
          title="Clear dictated text"
          onClick={() => controller.tap('close')}
        >
          <X size={11} strokeWidth={2.8} aria-hidden />
        </button>
        <ActivityBars height={18} />
      </div>
      {/* Bottom-anchored, so only the last two lines stay visible. */}
      <Panel className="dictation__text">
        <div className="dictation__window" aria-live="polite">
          <p className="dictation__lines">
            {head}
            <span className="dictation__tail">
              {text ? tail : <span className="dictation__placeholder">Sign to type...</span>}
              <span key={text} className="dictation__caret" aria-hidden />
            </span>
          </p>
        </div>
      </Panel>
      <Notice />
      <Footer listen settings chat />
    </Stack>
  )
}
