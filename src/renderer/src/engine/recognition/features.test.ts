import type { Handedness, Landmark } from '@shared/types'
import { describe, expect, it } from 'vitest'
import type { FrameSample, HandSample } from '../types'
import { euclidean } from './dtw'
import {
  FRAME_FEATURE_DIM,
  HAND_FEATURE_DIM,
  STATIC_FEATURE_DIM,
  frameFeatures,
  slotHands,
  slotPresent,
  slotVelocity,
  staticFeatures,
  type SlottedFrame
} from './features'
import { poseLandmarks, SHAPES, type HandPose } from './synthetic'

const ASPECT = 16 / 9

function pose(over: Partial<HandPose> = {}): HandPose {
  return { shape: SHAPES.L, handedness: 'Right', x: 0.5, y: 0.5, size: 0.2, roll: 10, pitch: 5, yaw: -5, ...over }
}

function hand(over: Partial<HandPose> = {}, score = 0.9): HandSample {
  const p = pose(over)
  return { handedness: p.handedness, score, landmarks: poseLandmarks(p, ASPECT) }
}

const close = (a: number[], b: number[], eps = 1e-9): void => expect(euclidean(a, b)).toBeLessThan(eps)

const slotted = ({ t, hands }: FrameSample): SlottedFrame => ({ t, hands: slotHands(hands) })

/** Features of `frame`, with velocity from `prev`. */
function features(frame: FrameSample, prev: FrameSample | null = null): number[] {
  return frameFeatures(slotted(frame), prev && slotted(prev), ASPECT)
}

describe('feature dimensions', () => {
  it('exports consistent sizes', () => {
    expect(STATIC_FEATURE_DIM).toBe(63)
    expect(HAND_FEATURE_DIM).toBe(67)
    expect(FRAME_FEATURE_DIM).toBe(134)
    expect(features({ t: 0, hands: [hand()] })).toHaveLength(FRAME_FEATURE_DIM)
    expect(staticFeatures(hand(), ASPECT)).toHaveLength(STATIC_FEATURE_DIM)
  })
})

describe('staticFeatures', () => {
  it('is invariant to where the hand is in the image and how big it is', () => {
    const base = staticFeatures(hand(), ASPECT)!
    close(staticFeatures(hand({ x: 0.2, y: 0.7 }), ASPECT)!, base)
    close(staticFeatures(hand({ size: 0.08 }), ASPECT)!, base)
    close(staticFeatures(hand({ x: 0.8, y: 0.3, size: 0.3 }), ASPECT)!, base)
  })

  it('centers on the wrist and scales the wrist -> middle MCP distance to 1', () => {
    const v = staticFeatures(hand(), ASPECT)!
    expect(v.slice(0, 3)).toEqual([0, 0, 0])
    const [x, y, z] = v.slice(27, 30)
    expect(Math.hypot(x, y, z * 2)).toBeCloseTo(1, 6) // z is stored at half weight
  })

  it('needs the true aspect ratio to keep proportions', () => {
    const p = pose()
    const sample = { handedness: p.handedness, score: 1, landmarks: poseLandmarks(p, ASPECT) }
    const squareCamera = { ...sample, landmarks: poseLandmarks(p, 1) }
    close(staticFeatures(sample, ASPECT)!, staticFeatures(squareCamera, 1)!, 1e-6)
    expect(euclidean(staticFeatures(sample, 1)!, staticFeatures(squareCamera, 1)!)).toBeGreaterThan(0.1)
  })

  it('maps a left hand onto the same shape as the right hand', () => {
    const right = staticFeatures(hand({ roll: 0, pitch: 0, yaw: 0 }), ASPECT)!
    const left = staticFeatures(hand({ handedness: 'Left', roll: 0, pitch: 0, yaw: 0 }), ASPECT)!
    close(left, right, 1e-6)
  })

  it('tells handshapes apart', () => {
    const l = staticFeatures(hand(), ASPECT)!
    const fist = staticFeatures(hand({ shape: SHAPES.S }), ASPECT)!
    expect(euclidean(l, fist)).toBeGreaterThan(1)
  })

  it('rejects degenerate hands', () => {
    const flat: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
    expect(staticFeatures({ handedness: 'Right', score: 1, landmarks: flat })).toBeNull()
    expect(staticFeatures({ handedness: 'Right', score: 1, landmarks: flat.slice(0, 5) })).toBeNull()
  })
})

describe('frameFeatures', () => {
  it('zero-fills a missing hand and slots a single hand by its handedness', () => {
    const onlyLeft = features({ t: 0, hands: [hand({ handedness: 'Left' })] })
    expect(slotPresent(onlyLeft, 0)).toBe(false)
    expect(slotPresent(onlyLeft, 1)).toBe(true)
    expect(onlyLeft.slice(0, HAND_FEATURE_DIM).every((v) => v === 0)).toBe(true)
    expect(features({ t: 0, hands: [] }).every((v) => v === 0)).toBe(true)
  })

  it('keeps two-handed frames in the same slots whatever order MediaPipe reports them', () => {
    const right = hand({ x: 0.35 })
    const left = hand({ handedness: 'Left', x: 0.65, shape: SHAPES.B })
    close(features({ t: 0, hands: [right, left] }), features({ t: 0, hands: [left, right] }))
  })

  it('gives the free slot to the less confident of two same-labeled hands', () => {
    const a = hand({}, 0.6)
    const b = hand({ x: 0.3 }, 0.9)
    expect(slotHands([a, b])).toEqual([b, a])
  })

  it('keeps two same-labeled hands in their places when their confidence order flips', () => {
    const first = slotHands([hand({ x: 0.3 }, 0.95), hand({ x: 0.7 }, 0.94)])
    const next = [hand({ x: 0.31 }, 0.93), hand({ x: 0.69 }, 0.96)]
    expect(slotHands(next)).toEqual([next[1], next[0]]) // by score alone they would swap
    expect(slotHands(next, first)).toEqual(next)
  })

  it('measures wrist velocity in hand lengths per second, independent of hand size', () => {
    for (const size of [0.1, 0.25]) {
      const prev = { t: 0, hands: [hand({ size })] }
      // 0.5 hand lengths to the right in 100 ms = 5 hand lengths / s.
      const next = { t: 100, hands: [hand({ size, x: 0.5 + (0.5 * size) / ASPECT })] }
      const [vx, vy] = slotVelocity(features(next, prev), 0)
      expect(vx).toBeCloseTo(5, 2) // the synthetic middle MCP sits 1.0002 hand lengths out
      expect(vy).toBeCloseTo(0, 6)
    }
  })

  it('is invariant to translation and scale apart from velocity', () => {
    const a = features({ t: 0, hands: [hand()] })
    const b = features({ t: 0, hands: [hand({ x: 0.3, y: 0.4, size: 0.1 })] })
    close(a, b, 1e-9)
  })

  it('gives no velocity across a long gap or a hand that just appeared', () => {
    const moved = { t: 1000, hands: [hand({ x: 0.7 })] }
    expect(slotVelocity(features(moved, { t: 0, hands: [hand()] }), 0)).toEqual([0, 0])
    expect(slotVelocity(features(moved, { t: 967, hands: [] }), 0)).toEqual([0, 0])
  })

  it('gives no velocity for a jump no hand could make (a glitch or two hands trading places)', () => {
    // 0.4 widths in one frame: ~4 hand lengths in 33 ms.
    expect(slotVelocity(features({ t: 33, hands: [hand({ x: 0.7 })] }, { t: 0, hands: [hand({ x: 0.3 })] }), 0)).toEqual([0, 0])
    // The same distance over 200 ms (a slow camera) is real motion.
    const [vx] = slotVelocity(features({ t: 200, hands: [hand({ x: 0.7 })] }, { t: 0, hands: [hand({ x: 0.3 })] }), 0)
    expect(vx).toBeGreaterThan(15)
  })

  it('records handedness in the slot', () => {
    const sides: Handedness[] = ['Right', 'Left']
    const f = features({ t: 0, hands: sides.map((handedness) => hand({ handedness })) })
    expect(f[1 + 63]).toBe(1)
    expect(f[HAND_FEATURE_DIM + 1 + 63]).toBe(-1)
  })
})
