import { useLayoutEffect, useRef } from 'react'
import './TokenStrip.css'

export interface TokenStripProps {
  /** Confirmed tokens in order (the current one included). */
  items: readonly string[]
  /** Index into `items` of the token being signed now; drawn brighter. */
  current?: number | null
  /** letters = letters over underline slots (spelling); words = word chips in a row. */
  variant: 'letters' | 'words'
  /** letters only: minimum slot count; slots past the last letter are dim placeholders. Default 5. */
  slots?: number
  className?: string
}

/** Max letter slots that fit the 300px card; older letters scroll off the left. */
const MAX_SLOTS = 8

export function TokenStrip({ items, current = null, variant, slots = 5, className }: TokenStripProps): React.JSX.Element {
  return variant === 'letters' ? (
    <LetterStrip items={items} current={current} slots={slots} className={className} />
  ) : (
    <WordStrip items={items} current={current} className={className} />
  )
}

function LetterStrip({ items, current, slots, className }: Omit<TokenStripProps, 'variant'>): React.JSX.Element {
  const visible = items.slice(-(MAX_SLOTS - 1))
  const offset = items.length - visible.length
  const count = Math.min(MAX_SLOTS, Math.max(slots ?? 5, visible.length + 1))
  return (
    <div className={`strip strip--letters${className ? ` ${className}` : ''}`}>
      {Array.from({ length: count }, (_, i) => {
        const letter = visible[i]
        const state = letter === undefined ? 'empty' : i + offset === current ? 'current' : 'done'
        return (
          <span key={i} className={`strip__slot strip__slot--${state}`}>
            <span className="strip__letter">{letter ?? ''}</span>
            <span className="strip__line" />
          </span>
        )
      })}
    </div>
  )
}

function WordStrip({ items, current, className }: Omit<TokenStripProps, 'variant' | 'slots'>): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Keep the newest word in view; fade the left edge when older words are cut off.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
    el.dataset.overflow = String(el.scrollWidth > el.clientWidth + 1)
  }, [items])
  return (
    <div ref={ref} className={`strip strip--words${className ? ` ${className}` : ''}`}>
      {items.map((word, i) => (
        <span key={`${i}-${word}`} className={`strip__chip${i === current ? ' strip__chip--current' : ''}`}>
          {word}
        </span>
      ))}
    </div>
  )
}
