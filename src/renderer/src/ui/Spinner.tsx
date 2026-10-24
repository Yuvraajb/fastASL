import './Spinner.css'

/** Small rotating ring (current agent step, "thinking"). */
export function Spinner({ size = 16, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      className={`spinner${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role="img"
      aria-label="In progress"
    >
      <circle cx="8" cy="8" r="6.5" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="6.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="13 40" />
    </svg>
  )
}
