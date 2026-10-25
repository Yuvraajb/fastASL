import type { Landmark } from '@shared/types'
import type { FrameSample } from '../types'
import type { MovementWindow } from './signModel'

/**
 * Dev calibration: one movement's tracked points as compact JSON, so live signing can be replayed
 * offline through both models (scripts outside the repo). Rounded to 4 decimals; z is dropped
 * (neither model uses it). Frames: { t, h: [[label, x0, y0, ...]], f: [x0, y0, ...], p: [...] }.
 */
export function dumpMovement(w: MovementWindow): string {
  const xy = (points: readonly Landmark[] | undefined): number[] | undefined =>
    points ? points.flatMap((p) => [round(p.x), round(p.y)]) : undefined
  const frames = w.frames.map((f: FrameSample) => ({
    t: Math.round(f.t),
    h: f.hands.map((h) => [h.handedness, ...xy(h.landmarks)!]),
    f: xy(f.face),
    p: xy(f.pose)
  }))
  return JSON.stringify({ start: w.start, end: w.end, frames })
}

const round = (v: number): number => Math.round(v * 1e4) / 1e4
