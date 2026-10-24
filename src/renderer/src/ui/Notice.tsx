import { Info } from 'lucide-react'
import { IDENTIFYING } from '../app/controller'
import { useApp } from '../app/store'
import './Notice.css'

export interface NoticeProps {
  /** Defaults to store.notice. Renders nothing when empty. */
  text?: string | null
  /** Lines shown before an ellipsis. Default 2. */
  lines?: number
  className?: string
}

/** Notice with an info icon, e.g. "Add ANTHROPIC_API_KEY to .env" (up to two lines, or `lines`). */
export function Notice({ text, lines, className }: NoticeProps): React.JSX.Element | null {
  const notice = useApp((s) => s.notice)
  const message = text === undefined ? notice : text
  // A guess in flight shows in the header (Header.tsx) instead: a row coming and going resizes the card.
  if (!message || (text === undefined && message === IDENTIFYING)) return null
  return (
    <div className={`notice${className ? ` ${className}` : ''}`} role="status" title={message}>
      <Info size={14} strokeWidth={2} aria-hidden />
      <span className="notice__text" style={lines ? { WebkitLineClamp: lines } : undefined}>
        {message}
      </span>
    </div>
  )
}
