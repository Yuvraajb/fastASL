import { X } from 'lucide-react'
import { controller } from '../app/context'
import './CloseButton.css'

export interface CloseButtonProps {
  /** Default: controller.tap('close'). */
  onClick?: () => void
  /** circle = 24px dark circle; plain = bare gray X, circle only on hover (header, ref2). */
  variant?: 'circle' | 'plain'
  size?: number
  label?: string
  className?: string
}

/** Small X used top-right of a card (header close variant, toasts). */
export function CloseButton({
  onClick = () => controller.tap('close'),
  variant = 'circle',
  size = 24,
  label = 'Close',
  className
}: CloseButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`close-btn close-btn--${variant}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {/* The plain X has no circle to frame it, so its glyph is drawn larger. */}
      <X size={Math.round(size * (variant === 'plain' ? 0.8 : 0.58))} strokeWidth={variant === 'plain' ? 2 : 2.2} aria-hidden />
    </button>
  )
}
