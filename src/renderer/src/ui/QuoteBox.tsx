import type { ReactNode } from 'react'
import './Panel.css'
import './QuoteBox.css'

export interface QuoteBoxProps {
  /** Sentence shown in curly quotes. */
  text: string
  /** panel = subtle dark rounded panel (default); plain = text only. */
  variant?: 'panel' | 'plain'
  /** Optional trailing element inside the panel (e.g. a thumbnail Feed). */
  aside?: ReactNode
  className?: string
}

/** Running sentence in quotes, 16px semibold, max 2 lines (phrase building, "Did you mean?"). */
export function QuoteBox({ text, variant = 'panel', aside, className }: QuoteBoxProps): React.JSX.Element {
  return (
    <div className={`quote quote--${variant}${variant === 'panel' ? ' panel' : ''}${className ? ` ${className}` : ''}`}>
      <p className="quote__text">{text ? `“${text}”` : ' '}</p>
      {aside}
    </div>
  )
}
