import { useEffect, useLayoutEffect, useRef } from 'react'

/** Calls `callback(seconds)` every animation frame while `active`. The latest callback is always used. */
export function useAnimationFrame(callback: (t: number) => void, active = true): void {
  const ref = useRef(callback)
  useLayoutEffect(() => {
    ref.current = callback
  })
  useEffect(() => {
    if (!active) return
    let id = 0
    const loop = (now: number): void => {
      ref.current(now / 1000)
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [active])
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
