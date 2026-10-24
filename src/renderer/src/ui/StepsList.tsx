import type { StepStatus } from '@shared/types'
import { Spinner } from './Spinner'
import './StepsList.css'

export interface StepItem {
  id: string
  label: string
  status: StepStatus
}

export interface StepsListProps {
  steps: readonly StepItem[]
  className?: string
}

function StepIcon({ status }: { status: StepStatus }): React.JSX.Element {
  switch (status) {
    case 'done':
      return (
        <svg className="steps__icon" width="16" height="16" viewBox="0 0 16 16" aria-label="Done">
          <circle cx="8" cy="8" r="8" fill="#fff" />
          <path d="M4.6 8.2l2.2 2.2 4.6-4.7" fill="none" stroke="#0b0b0c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'current':
      return <Spinner className="steps__icon" />
    case 'error':
      return (
        <svg className="steps__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Failed">
          <circle cx="8" cy="8" r="7.25" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="rgba(255,255,255,0.75)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg className="steps__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Pending">
          <circle cx="8" cy="8" r="7.25" stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" />
        </svg>
      )
  }
}

/** Agent steps: filled check = done, spinner = current, hollow circle = pending. */
export function StepsList({ steps, className }: StepsListProps): React.JSX.Element {
  return (
    <ol className={`steps${className ? ` ${className}` : ''}`}>
      {steps.map((step) => (
        <li key={step.id} className={`steps__row steps__row--${step.status}`}>
          <StepIcon status={step.status} />
          <span className="steps__label">{step.label}</span>
        </li>
      ))}
    </ol>
  )
}
