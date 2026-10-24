import { ChevronDown } from 'lucide-react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { useApp } from '../app/store'
import { Feed, HoldRing } from '../ui'
import './CollapsedView.css'

type Props = { view: Extract<View, { kind: 'collapsed' }> }

/** Reference image 2, panel 1: live thumbnail, status dot, name, chevron. Open palm for 1s expands. */
export function CollapsedView(_props: Props): React.JSX.Element {
  const holdProgress = useApp((s) => s.holdProgress)
  const cameraOn = useApp((s) => s.cameraOn)
  // No room for a Notice row in the pill: a pending notice replaces the name.
  const notice = useApp((s) => s.notice)
  return (
    <button type="button" className="collapsed" onClick={() => controller.tap('expand')} aria-label="Expand fastASL">
      <span className="collapsed__thumb">
        <Feed variant="round" size={28} />
        {holdProgress > 0 ? <HoldRing progress={holdProgress} size={36} stroke={2} className="collapsed__ring" /> : null}
      </span>
      <span className={`collapsed__dot${cameraOn ? ' collapsed__dot--on' : ''}`} aria-hidden />
      <span className={`collapsed__name${notice ? ' collapsed__name--notice' : ''}`} title={notice ?? undefined}>
        {notice ?? 'fastASL'}
      </span>
      <span className="collapsed__chevron" aria-hidden>
        <ChevronDown size={16} strokeWidth={2.2} />
      </span>
    </button>
  )
}
