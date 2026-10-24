import { describe, expect, it } from 'vitest'
import type { Handedness, Landmark } from '@shared/types'
import type { FrameSample, HandSample } from '../types'
import { INITIAL_MOTION, frameSpeed, handSize, stepMotion, type MotionState } from './motion'

/** A flat 21-point hand: wrist at (cx, cy), palm span `size` (normalized units). */
function hand(cx: number, cy: number, size = 0.1, handedness: Handedness = 'Right'): HandSample {
  const landmarks: Landmark[] = Array.from({ length: 21 }, (_, i) => ({
    x: cx + ((i % 5) - 2) * size * 0.25,
    y: cy - Math.floor(i / 5) * size * 0.25,
    z: 0
  }))
  landmarks[0] = { x: cx, y: cy, z: 0 }
  landmarks[9] = { x: cx, y: cy - size, z: 0 }
  landmarks[5] = { x: cx - size * 0.4, y: cy - size, z: 0 }
  landmarks[17] = { x: cx + size * 0.4, y: cy - size, z: 0 }
  return { landmarks, handedness, score: 0.9 }
}

const frame = (t: number, ...hands: HandSample[]): FrameSample => ({ t, hands })

/** Run frames every `stepMs` for `durationMs`, with hands given as a function of time. */
function run(durationMs: number, stepMs: number, hands: (t: number) => HandSample[], start = INITIAL_MOTION): MotionState {
  let state = start
  for (let t = 0; t <= durationMs; t += stepMs) state = stepMotion(state, frame(t, ...hands(t)))
  return state
}

/** Hand moving horizontally at `speed` hand sizes per second. */
const moving = (speed: number, size = 0.1) => (t: number) => [hand(0.2 + (speed * size * t) / 1000, 0.6, size)]

describe('handSize', () => {
  it('uses the larger palm span', () => {
    expect(handSize(hand(0.5, 0.5, 0.2).landmarks)).toBeCloseTo(0.2)
  })

  it('applies the aspect ratio to x', () => {
    const h = hand(0.5, 0.5, 0.1)
    // index->pinky span is horizontal (0.08), wrist->middle is vertical (0.1)
    expect(handSize(h.landmarks, 2)).toBeCloseTo(0.16)
  })
})

describe('frameSpeed', () => {
  it('is zero for a still hand', () => {
    expect(frameSpeed(frame(0, hand(0.5, 0.5)), frame(33, hand(0.5, 0.5)))).toBe(0)
  })

  it('measures speed in hand sizes per second', () => {
    // moves 0.05 = half a hand size in 100ms -> 5 hand sizes / s
    expect(frameSpeed(frame(0, hand(0.5, 0.5)), frame(100, hand(0.55, 0.5)))).toBeCloseTo(5)
  })

  it('is independent of distance to the camera', () => {
    const near = frameSpeed(frame(0, hand(0.5, 0.5, 0.2)), frame(100, hand(0.6, 0.5, 0.2)))
    const far = frameSpeed(frame(0, hand(0.5, 0.5, 0.05)), frame(100, hand(0.525, 0.5, 0.05)))
    expect(near).toBeCloseTo(far)
  })

  it('pairs hands by position, not list order or label', () => {
    const prev = frame(0, hand(0.2, 0.5, 0.1, 'Left'), hand(0.8, 0.5, 0.1, 'Right'))
    const next = frame(33, hand(0.8, 0.5, 0.1, 'Left'), hand(0.2, 0.5, 0.1, 'Right'))
    expect(frameSpeed(prev, next)).toBe(0)
  })

  it('reports the fastest hand', () => {
    const prev = frame(0, hand(0.2, 0.5), hand(0.8, 0.5))
    const next = frame(100, hand(0.2, 0.5), hand(0.85, 0.5))
    expect(frameSpeed(prev, next)).toBeCloseTo(5)
  })

  it('ignores hands that appear or jump across the frame', () => {
    expect(frameSpeed(frame(0), frame(33, hand(0.5, 0.5)))).toBe(0)
    expect(frameSpeed(frame(0, hand(0.1, 0.5)), frame(33, hand(0.9, 0.5)))).toBe(0)
  })

  it('scales horizontal motion by the aspect ratio', () => {
    const prev = frame(0, hand(0.5, 0.5))
    const next = frame(100, hand(0.55, 0.5))
    expect(frameSpeed(prev, next, 16 / 9)).toBeGreaterThan(frameSpeed(prev, next, 1))
  })

  it('does not blow up on near-duplicate timestamps', () => {
    expect(frameSpeed(frame(0, hand(0.5, 0.5)), frame(0.1, hand(0.51, 0.5)))).toBeLessThan(20)
  })
})

describe('stepMotion', () => {
  it('starts at zero and stays there for a still hand with jitter', () => {
    const state = run(2000, 33, (t) => [hand(0.5 + (t % 66 ? 0.0005 : -0.0005), 0.5)])
    expect(state.energy).toBeLessThan(0.01)
  })

  it('rises with motion and stays within 0..1', () => {
    const slow = run(1000, 33, moving(1.5)).energy
    const fast = run(1000, 33, moving(6)).energy
    const wild = run(1000, 33, moving(40)).energy
    expect(slow).toBeGreaterThan(0.1)
    expect(fast).toBeGreaterThan(slow)
    expect(wild).toBeGreaterThan(fast)
    expect(wild).toBeLessThanOrEqual(1)
  })

  it('decays back to rest when the hand stops or leaves', () => {
    const active = run(1000, 33, moving(6))
    const stopped = run(1000, 33, () => [hand(0.5, 0.5)], { ...active, last: null })
    const gone = run(1000, 33, () => [], { ...active, last: null })
    expect(active.energy).toBeGreaterThan(0.5)
    expect(stopped.energy).toBeLessThan(0.01)
    expect(gone.energy).toBeLessThan(0.01)
  })

  it('smooths by time, not frame count', () => {
    const at30 = run(400, 1000 / 30, moving(6)).energy
    const at15 = run(400, 1000 / 15, moving(6)).energy
    expect(Math.abs(at30 - at15)).toBeLessThan(0.05)
  })

  it('reacts within a few hundred milliseconds', () => {
    const settled = run(2000, 33, moving(6)).energy
    expect(run(300, 33, moving(6)).energy).toBeGreaterThan(settled * 0.8)
  })

  it('ignores frames that do not move forward in time', () => {
    const state = stepMotion(stepMotion(INITIAL_MOTION, frame(100, hand(0.5, 0.5))), frame(100, hand(0.9, 0.5)))
    expect(state.energy).toBe(0)
  })
})
