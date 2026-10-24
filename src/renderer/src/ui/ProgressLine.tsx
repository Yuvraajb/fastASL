import type { CSSProperties } from 'react'
import './ProgressLine.css'

export interface ProgressLineProps {
  /** Time for the line to run out, ms (match the toast / auto-collapse timer). */
  duration: number
  /** Track width px; default 100% of the parent. */
  width?: number
  className?: string
}

/** Thin white line that shrinks to nothing over `duration` (toast countdown, reference image 2 panel 7). */
export function ProgressLine({ duration, width, className }: ProgressLineProps): React.JSX.Element {
  const style = { '--progress-duration': `${duration}ms`, width } as CSSProperties
  return (
    <span className={`progress-line${className ? ` ${className}` : ''}`} style={style} aria-hidden>
      <span className="progress-line__fill" />
    </span>
  )
}
