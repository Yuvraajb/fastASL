import type { ReactNode } from 'react'
import './TokenPill.css'

export interface TokenPillProps {
  /** The recognized sign: a letter ("A") or a word ("meeting"). */
  text?: string | null
  /** Wrap in curly quotes, for words in the detect state. */
  quoted?: boolean
  /** pill = dark rounded background (default); bare = text only (big current letter while building). */
  variant?: 'pill' | 'bare'
  /** Shrink to content instead of spanning the card width. */
  fit?: boolean
  /** Replaces the text, e.g. <ActivityBars/> while listening. */
  children?: ReactNode
  className?: string
}

/** Centered 22px semibold token under the feed. Keeps its height when empty. */
export function TokenPill({ text, quoted = false, variant = 'pill', fit = false, children, className }: TokenPillProps): React.JSX.Element {
  const label = text ? (quoted ? `“${text}”` : text) : ''
  return (
    <div className={`token token--${variant}${fit ? ' token--fit' : ''}${className ? ` ${className}` : ''}`} aria-live="polite">
      {/* Keyed so each new sign pops in. */}
      {children ?? (
        <span key={label} className="token__text">
          {label}
        </span>
      )}
    </div>
  )
}
