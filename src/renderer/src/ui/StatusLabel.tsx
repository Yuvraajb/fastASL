import type { StatusTone } from '../app/types'
import './StatusLabel.css'

export interface StatusLabelProps {
  label: string
  /** active = green dot (Ready, Listening, Reply, Done); idle = gray dot. */
  tone: StatusTone
  className?: string
}

/** 6px status dot + 12px label, top-right of the card header. */
export function StatusLabel({ label, tone, className }: StatusLabelProps): React.JSX.Element {
  return (
    <span className={`status status--${tone}${className ? ` ${className}` : ''}`} role="status">
      <span className="status__dot" aria-hidden />
      <span className="status__label">{label}</span>
    </span>
  )
}
