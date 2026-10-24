import { useState } from 'react'
import { live } from '../app/live'
import { useAnimationFrame } from './useAnimationFrame'

/** `live.error` (why the camera isn't running) as React state: polled every frame, re-rendering only on a change. */
export function useLiveError(active = true): string | null {
  const [error, setError] = useState<string | null>(live.error)
  useAnimationFrame(() => {
    if (live.error !== error) setError(live.error)
  }, active)
  return error
}
