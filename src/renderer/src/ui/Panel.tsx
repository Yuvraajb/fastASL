import type { CSSProperties, ReactNode } from 'react'
import './Panel.css'

export interface PanelProps {
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/** Dark rounded box on the card (--surface, radius 12, padding 10 12): details, dictated text, empty states. */
export function Panel({ children, className, style }: PanelProps): React.JSX.Element {
  return (
    <div className={`panel${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  )
}
