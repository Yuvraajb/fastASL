import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import './Button.css'

export interface ButtonProps {
  children?: ReactNode
  /** primary = white pill, black text; secondary = dark pill, white text; round = icon-only dark circle. */
  variant?: 'primary' | 'secondary' | 'round'
  icon?: LucideIcon
  /** Where the icon sits next to the label. Default 'trailing' ("Send to agent ->", "Confirm ✓"). */
  iconPosition?: 'leading' | 'trailing'
  onClick?: () => void
  /** fill = full width; flex = share a ButtonRow equally. */
  stretch?: 'fill' | 'flex'
  /** Accessible name (required for round buttons). */
  label?: string
  disabled?: boolean
  className?: string
}

/** 38px pill button. */
export function Button({
  children,
  variant = 'primary',
  icon: Icon,
  iconPosition = 'trailing',
  onClick,
  stretch,
  label,
  disabled,
  className
}: ButtonProps): React.JSX.Element {
  const glyph = Icon ? <Icon size={variant === 'round' ? 18 : 16} strokeWidth={2.1} aria-hidden /> : null
  return (
    <button
      type="button"
      className={`btn btn--${variant}${stretch ? ` btn--${stretch}` : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={variant === 'round' ? label : undefined}
    >
      {iconPosition === 'leading' ? glyph : null}
      {variant === 'round' ? null : <span className="btn__label">{children}</span>}
      {iconPosition === 'trailing' ? glyph : null}
    </button>
  )
}

/** Horizontal group of buttons with an 8px gap. */
export function ButtonRow({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={`btn-row${className ? ` ${className}` : ''}`}>{children}</div>
}
