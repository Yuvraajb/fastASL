import type { ReactNode } from 'react'
import './HoldRing.css'

export interface HoldRingProps {
  /** 0..1 */
  progress: number
  /** Outer diameter px. Default 20. */
  size?: number
  stroke?: number
  /** Draw the faint full-circle track. Default true. */
  track?: boolean
  /** Centered content (e.g. the collapsed pill's thumbnail). */
  children?: ReactNode
  className?: string
}

/** Circular progress for "hold to activate" (open palm) and finger-count holds. */
export function HoldRing({ progress, size = 20, stroke = 2, track = true, children, className }: HoldRingProps): React.JSX.Element {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.min(1, Math.max(0, progress))
  return (
    <span className={`hold${className ? ` ${className}` : ''}`} style={{ width: size, height: size }}>
      {children ? <span className="hold__content">{children}</span> : null}
      <svg className="hold__ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden>
        {track ? <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.2)" strokeWidth={stroke} /> : null}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="#fff"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </span>
  )
}
