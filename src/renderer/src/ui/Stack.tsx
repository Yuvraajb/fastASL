import type { CSSProperties, ReactNode } from 'react'
import './Stack.css'

export interface StackProps {
  children: ReactNode
  /** Vertical gap in px. Default 10 (the card rhythm). */
  gap?: number
  align?: 'stretch' | 'center' | 'start'
  className?: string
  style?: CSSProperties
}

/** Vertical layout with the standard card rhythm. Every view's root is a Stack. */
export function Stack({ children, gap = 10, align = 'stretch', className, style }: StackProps): React.JSX.Element {
  return (
    <div className={`stack stack--${align}${className ? ` ${className}` : ''}`} style={{ gap, ...style }}>
      {children}
    </div>
  )
}

/** 1px hairline separator. */
export function Divider({ className }: { className?: string }): React.JSX.Element {
  return <hr className={`divider${className ? ` ${className}` : ''}`} />
}
