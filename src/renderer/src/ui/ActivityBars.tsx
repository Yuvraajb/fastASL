import { useRef } from 'react'
import { live } from '../app/live'
import { prefersReducedMotion, useAnimationFrame } from './useAnimationFrame'
import './ActivityBars.css'

export interface ActivityBarsProps {
  /** Number of bars. Default 12. */
  count?: number
  /** Max bar height in px. Default 20. */
  height?: number
  className?: string
}

/** Lowest bar height as a fraction of `height` (a short dash when the hands are still). */
const FLOOR = 0.14

/**
 * A row of thin vertical bars driven by hand-motion speed (live.motion, 0..1),
 * never audio. Heights are written straight to the DOM in rAF.
 */
export function ActivityBars({ count = 12, height = 20, className }: ActivityBarsProps): React.JSX.Element {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const level = useRef<number[]>([])

  useAnimationFrame((t) => {
    const still = prefersReducedMotion()
    // Mock mode has no real motion: use a slow synthetic "signing" rhythm.
    const motion = live.mock ? 0.55 + 0.25 * Math.sin(t * 1.7) + 0.12 * Math.sin(t * 4.3) : live.motion
    const center = (count - 1) * 0.42
    for (let i = 0; i < count; i++) {
      const el = bars.current[i]
      if (!el) continue
      // Bell-shaped envelope (taller left of center) times a per-bar flicker.
      const envelope = 0.3 + 0.7 * Math.exp(-(((i - center) / (count * 0.3)) ** 2))
      const flicker = still ? 0.7 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (3.1 + i * 0.37) + i * 1.9))
      const target = FLOOR + (1 - FLOOR) * Math.min(1, Math.max(0, motion) * envelope * flicker * 1.7)
      const prev = level.current[i] ?? target
      const next = still ? target : prev + (target - prev) * 0.3
      level.current[i] = next
      el.style.transform = `scaleY(${next.toFixed(3)})`
    }
  })

  return (
    <div className={`bars${className ? ` ${className}` : ''}`} style={{ height }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="bars__bar"
          ref={(el) => {
            bars.current[i] = el
          }}
        />
      ))}
    </div>
  )
}
