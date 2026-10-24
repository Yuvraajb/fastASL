import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'
import { controller } from '../app/context'
import { useApp } from '../app/store'
import { HoldRing } from './HoldRing'
import './OptionList.css'

export interface OptionItem {
  label: string
  /** Line icon before the label (quick menu, context actions, settings). */
  icon?: LucideIcon
  /** Gray label (e.g. "More options"). */
  muted?: boolean
  /** Small gray text on the right (e.g. a gesture's task). */
  detail?: string
  /** Second line in gray under the label (a level's note, a stream URL). Row grows to 44px. */
  sub?: string
  /** Render `sub` in monospace (URLs). */
  mono?: boolean
  /** Small outlined chip on the right, e.g. "built-in". */
  tag?: string
}

export interface OptionListProps {
  options: readonly (string | OptionItem)[]
  /** Show 1..5 number badges (the finger count that picks the row). Default true. */
  numbered?: boolean
  /**
   * Where the number badge sits. Default: 'trailing' when any option has an icon
   * (the icon leads the row), 'leading' otherwise.
   */
  badge?: 'leading' | 'trailing'
  /** plain = bare 16px icon, 34px rows (quick menu); circle = icon in a 30px dark circle, 40px rows (context actions). */
  iconStyle?: 'plain' | 'circle'
  /** Index of the current value (settings): a gray check on the right. */
  selected?: number | null
  /** Default: controller.tap('option', index). */
  onPick?: (index: number) => void
  className?: string
}

/** Diameter of the hold ring drawn around the badge (matches --badge-box). */
const RING = 24

/** Finger-count badge. While its count is held, a ring fills around it (never a free-standing arc, which reads as a spinner). */
function Badge({ n, progress }: { n: number; progress: number | null }): React.JSX.Element {
  const num = <span className="opts__num">{n}</span>
  return progress === null ? (
    <span className="opts__badge">{num}</span>
  ) : (
    <HoldRing progress={progress} size={RING} stroke={1.75} className="opts__badge">
      {num}
    </HoldRing>
  )
}

/**
 * Numbered rows picked by holding up N fingers (or a click). The row matching the
 * finger count in progress (store.pick) is highlighted and its badge gets the hold ring.
 */
export function OptionList({
  options,
  numbered = true,
  badge,
  iconStyle = 'plain',
  selected = null,
  onPick = (i) => controller.tap('option', i),
  className
}: OptionListProps): React.JSX.Element {
  const pick = useApp((s) => s.pick)
  const items = options.map((raw): OptionItem => (typeof raw === 'string' ? { label: raw } : raw))
  const side = badge ?? (items.some((item) => item.icon) ? 'trailing' : 'leading')
  return (
    <ul className={`opts opts--${iconStyle}${numbered ? ` opts--badge-${side}` : ''}${className ? ` ${className}` : ''}`}>
      {items.map((item, i) => {
        const n = i + 1
        const holding = pick?.count === n
        const Icon = item.icon
        const num = numbered ? <Badge n={n} progress={holding && pick ? pick.progress : null} /> : null
        const rowClass = `opts__row${item.sub ? ' opts__row--two' : ''}${holding ? ' opts__row--holding' : ''}${item.muted ? ' opts__row--muted' : ''}`
        return (
          <li key={`${i}-${item.label}`}>
            <button type="button" className={rowClass} onClick={() => onPick(i)}>
              {side === 'leading' ? num : null}
              {Icon ? (
                <span className="opts__icon">
                  <Icon size={16} strokeWidth={1.9} aria-hidden />
                </span>
              ) : null}
              <span className="opts__text">
                <span className="opts__label">{item.label}</span>
                {item.sub ? <span className={`opts__sub${item.mono ? ' opts__sub--mono' : ''}`}>{item.sub}</span> : null}
              </span>
              {item.detail ? <span className="opts__detail">{item.detail}</span> : null}
              {item.tag ? <span className="opts__tag">{item.tag}</span> : null}
              {selected === i ? <Check className="opts__check" size={15} strokeWidth={2.2} aria-label="Current" /> : null}
              {side === 'trailing' ? num : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
