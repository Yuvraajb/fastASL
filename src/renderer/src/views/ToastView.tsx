import { useRef } from 'react'
import { HandFist, ThumbsUp } from 'lucide-react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { toastDuration } from '../app/controller'
import { CheckBadge, Feed, Hint, Notice, ProgressLine, Stack } from '../ui'
import { useCardFadeOut, useViewInstance } from './agent-parts'
import './ToastView.css'

type ToastState = Extract<View, { kind: 'toast' }>
type Props = { view: ToastState }

/** Each new toast (even an identical one) remounts, restarting the countdown and fade. */
export function ToastView({ view }: Props): React.JSX.Element {
  const instance = useViewInstance(view)
  return <Toast key={instance} view={view} />
}

/**
 * Reference image 2, panel 7 (+ image 1, panel 9): result, countdown line, thumbnail. No header.
 * A click on the text dismisses. A screenshot shows itself in place of the camera tile, and a
 * click or a thumbs up opens it in Preview (the toast stays longer then, toastDuration).
 */
function Toast({ view }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const duration = toastDuration(view)
  useCardFadeOut(ref, duration)
  return (
    <Stack>
      <div ref={ref} className="toast">
        <button type="button" className="toast__main" title="Dismiss" onClick={() => controller.tap('close')}>
          <span className="toast__head">
            <CheckBadge ok={view.ok} size={30} />
            <span className="toast__text" role="status">
              <span className="toast__title">{view.title}</span>
              {view.subtitle ? <span className="toast__subtitle">{view.subtitle}</span> : null}
              {view.meta ? <span className="toast__meta">{view.meta}</span> : null}
            </span>
          </span>
          <ProgressLine duration={duration} width={96} />
        </button>
        {view.thumb ? (
          <button type="button" className="toast__shot" title="Open in Preview" onClick={() => controller.tap('primary')}>
            <img src={view.thumb} alt="Screenshot" draggable={false} />
          </button>
        ) : (
          <Feed variant="thumb" width={60} height={60} />
        )}
      </div>
      <Notice />
      {view.thumb ? (
        <Hint
          items={[
            { icon: ThumbsUp, label: 'open in Preview' },
            { icon: HandFist, label: 'dismiss' }
          ]}
        />
      ) : null}
    </Stack>
  )
}
