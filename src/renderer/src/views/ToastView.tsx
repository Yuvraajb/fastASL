import { useRef } from 'react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { CheckBadge, Feed, Notice, ProgressLine, Stack } from '../ui'
import { useCardFadeOut, useViewInstance } from './agent-parts'
import './ToastView.css'

type ToastState = Extract<View, { kind: 'toast' }>
type Props = { view: ToastState }

/** Matches the controller's TOAST_MS: the view is swapped back when this runs out. */
const TOAST_MS = 2600

/** Each new toast (even an identical one) remounts, restarting the countdown and fade. */
export function ToastView({ view }: Props): React.JSX.Element {
  const instance = useViewInstance(view)
  return <Toast key={instance} view={view} />
}

/** Reference image 2, panel 7 (+ image 1, panel 9): result, countdown line, thumbnail. No header. Click dismisses. */
function Toast({ view }: Props): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  useCardFadeOut(ref, TOAST_MS)
  return (
    <Stack>
      <button ref={ref} type="button" className="toast" title="Dismiss" onClick={() => controller.tap('close')}>
        <span className="toast__main">
          <span className="toast__head">
            <CheckBadge ok={view.ok} size={30} />
            <span className="toast__text" role="status">
              <span className="toast__title">{view.title}</span>
              {view.subtitle ? <span className="toast__subtitle">{view.subtitle}</span> : null}
              {view.meta ? <span className="toast__meta">{view.meta}</span> : null}
            </span>
          </span>
          <ProgressLine duration={TOAST_MS} width={96} />
        </span>
        <Feed variant="thumb" width={60} height={60} />
      </button>
      <Notice />
    </Stack>
  )
}
