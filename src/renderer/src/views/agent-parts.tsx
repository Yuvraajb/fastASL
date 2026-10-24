import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import type { LucideIcon } from 'lucide-react'
import { useApp } from '../app/store'
import { HoldRing } from '../ui'
import { prefersReducedMotion } from '../ui/useAnimationFrame'
import './agent-parts.css'

// Shared pieces for the agent flow views (agent ready, working, confirm, done, toast).

/**
 * Counts view objects: the number changes whenever the controller sets a new
 * view, even of the same kind. Use it as a `key` so countdowns restart per state.
 */
export function useViewInstance(view: object): number {
  const [seen, setSeen] = useState({ view, n: 0 })
  if (seen.view === view) return seen.n
  const next = { view, n: seen.n + 1 }
  setSeen(next)
  return next.n
}

/**
 * Fades the whole card out over the last `fadeMs` of `totalMs` (toast). The
 * controller swaps the view at `totalMs`; unmounting cancels the fade.
 */
export function useCardFadeOut(ref: RefObject<HTMLElement | null>, totalMs: number, fadeMs = 240): void {
  useEffect(() => {
    const card = ref.current?.closest<HTMLElement>('.card')
    if (!card || prefersReducedMotion()) return
    const anim = card.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: fadeMs,
      delay: Math.max(0, totalMs - fadeMs),
      easing: 'ease-in',
      fill: 'forwards'
    })
    return () => anim.cancel()
  }, [ref, totalMs, fadeMs])
}

export interface DetailPanelProps {
  /** Leading line icon (calendar, mail...). */
  icon?: LucideIcon
  /** Right-hand slot, e.g. an app tile. */
  aside?: ReactNode
  children: ReactNode
  className?: string
}

/** Dark rounded box with an icon and stacked lines (confirm details, email target). */
export function DetailPanel({ icon: Icon, aside, children, className }: DetailPanelProps): React.JSX.Element {
  return (
    <div className={`detail${className ? ` ${className}` : ''}`}>
      {Icon ? <Icon className="detail__icon" size={18} strokeWidth={1.9} aria-hidden /> : null}
      <div className="detail__body">{children}</div>
      {aside}
    </div>
  )
}

/** 0..1 progress while `n` fingers (1-based option) are held up; null otherwise. */
export function useHeld(n: number): number | null {
  return useApp((s) => (s.pick?.count === n ? s.pick.progress : null))
}

/** Label with a small filling ring while its finger count is held (same feedback as OptionList rows). */
export function PickLabel({ progress, children }: { progress: number | null; children: ReactNode }): React.JSX.Element {
  return (
    <span className="pick-label">
      {progress !== null ? <HoldRing progress={progress} size={14} stroke={2} /> : null}
      {children}
    </span>
  )
}
