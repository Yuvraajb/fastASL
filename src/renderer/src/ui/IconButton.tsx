import type { LucideIcon } from 'lucide-react'
import './IconButton.css'

export interface IconButtonProps {
  icon: LucideIcon
  /** Accessible name and tooltip. */
  label: string
  onClick?: () => void
  /** plain = bare icon (footer); filled = icon in a subtle circle (pencil, proceed ">"). */
  variant?: 'plain' | 'filled'
  /** light = near-white icon (default), dim = gray icon (inactive / indicator). */
  tone?: 'light' | 'dim'
  /** Button box in px. Default 32. */
  size?: number
  /** Icon glyph in px. Default 20. */
  iconSize?: number
  /** Non-interactive status glyph (e.g. mic-off): no hover, not focusable. */
  indicator?: boolean
  className?: string
}

/** 32px square icon button with a lucide line icon. */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  variant = 'plain',
  tone = 'light',
  size = 32,
  iconSize = 20,
  indicator = false,
  className
}: IconButtonProps): React.JSX.Element {
  const cls = `icon-btn icon-btn--${variant} icon-btn--${tone}${indicator ? ' icon-btn--indicator' : ''}${className ? ` ${className}` : ''}`
  const glyph = <Icon size={iconSize} strokeWidth={1.9} aria-hidden />
  if (indicator) {
    return (
      <span className={cls} style={{ width: size, height: size }} role="img" aria-label={label} title={label}>
        {glyph}
      </span>
    )
  }
  return (
    <button type="button" className={cls} style={{ width: size, height: size }} onClick={onClick} aria-label={label} title={label}>
      {glyph}
    </button>
  )
}
