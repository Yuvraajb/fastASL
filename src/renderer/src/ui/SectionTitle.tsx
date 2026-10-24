import type { ReactNode } from 'react'
import './SectionTitle.css'

export interface SectionTitleProps {
  children: ReactNode
  className?: string
}

/** Heading above a menu or option list: "Did you mean...", "What would you like to do?", settings page titles. */
export function SectionTitle({ children, className }: SectionTitleProps): React.JSX.Element {
  return <h2 className={`section-title${className ? ` ${className}` : ''}`}>{children}</h2>
}
