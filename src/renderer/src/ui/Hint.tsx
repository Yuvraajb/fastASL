import { Fragment, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import './Hint.css'

export interface HintItem {
  label: string
  /** Small line icon before the label. Monochrome, never emoji. */
  icon?: LucideIcon
}

export interface HintProps {
  /** Segments joined by a middle dot: [icon] label · [icon] label. */
  items?: readonly (string | HintItem)[]
  /** Free-form content instead of `items`. */
  children?: ReactNode
  className?: string
}

/** One centered line of 11px dim help text, e.g. "hold up 1-5 fingers · fist = back". */
export function Hint({ items, children, className }: HintProps): React.JSX.Element {
  return (
    <p className={`hint${className ? ` ${className}` : ''}`}>
      {items
        ? items.map((raw, i) => {
            const { label, icon: Icon } = typeof raw === 'string' ? { label: raw, icon: undefined } : raw
            return (
              <Fragment key={`${i}-${label}`}>
                {i > 0 ? (
                  <span className="hint__sep" aria-hidden>
                    ·
                  </span>
                ) : null}
                <span className="hint__item">
                  {Icon ? <Icon size={12} strokeWidth={2} aria-hidden /> : null}
                  {label}
                </span>
              </Fragment>
            )
          })
        : children}
    </p>
  )
}
