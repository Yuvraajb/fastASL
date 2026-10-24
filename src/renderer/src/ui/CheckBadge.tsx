import './CheckBadge.css'

export interface CheckBadgeProps {
  /** Diameter px. Default 28. */
  size?: number
  /** true = green with a dark check (success); false = gray with an X (failure). Default true. */
  ok?: boolean
  className?: string
}

/** Success badge for Done / toasts (reference image 3, panel 8). */
export function CheckBadge({ size = 28, ok = true, className }: CheckBadgeProps): React.JSX.Element {
  return (
    <span
      className={`check-badge${ok ? '' : ' check-badge--fail'}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ok ? 'Success' : 'Failed'}
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 14 14" fill="none" aria-hidden>
        {ok ? (
          <path d="M2.6 7.3l2.8 2.8 6-6.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        )}
      </svg>
    </span>
  )
}
