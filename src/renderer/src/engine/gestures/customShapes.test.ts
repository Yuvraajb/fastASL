import type { CustomGesture, SignTemplate } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { STATIC_FEATURE_DIM, staticFeatures } from '../recognition/features'
import { performHolds, rng, SHAPES, type ShapeName } from '../recognition/synthetic'
import { SENSITIVITY, type FrameSample } from '../types'
import { GestureEngine } from './engine'
import { CAPTURE_REASONS, SHAPE_SAMPLES, captureShape, shapeMatcher, type ShapeCapture } from './customShapes'
import { makeHand, Timeline, type HandSpec, type PoseName } from './synthetic'

type HoldOptions = Partial<Parameters<typeof performHolds>[1]>

const ASPECT = 4 / 3
/** A small hand (far from the camera) with ~2.6 px of jitter at 640 px. */
const FAR: HoldOptions = { handSize: 0.1, noise: 0.004 }

const hold = (shape: ShapeName, seed: number, extra: HoldOptions = {}, holdMs = 1100): FrameSample[] =>
  performHolds([{ shape, holdMs }], { random: rng(seed), aspect: ASPECT, ...extra })
const pose = (spec: HandSpec, ms = 1100): FrameSample[] => new Timeline({ aspect: ASPECT }).hold(ms, { noise: 0.002, ...spec }).frames

function saved(capture: ShapeCapture): number[][] {
  if (!capture.ok) throw new Error(`capture refused: ${capture.reason}`)
  return capture.shape
}

/** A letter as Teach a sign records it: five repetitions, one static vector each. */
const taughtLetter = (shape: ShapeName): SignTemplate[] =>
  [50, 51, 52, 53, 54].map((seed, i) => ({
    id: `${shape}-${i}`,
    label: shape,
    kind: 'letter',
    frames: [staticFeatures(hold(shape, seed)[15].hands[0], ASPECT)!],
    createdAt: 0
  }))

/** gestures.json entries edited by hand, as the renderer may receive them. */
const MALFORMED = [
  { id: 'none', shape: undefined },
  { id: 'null', shape: null },
  { id: 'vectors', shape: [null, 'x', [1, 2, 3], new Array(STATIC_FEATURE_DIM).fill(NaN)] }
] as unknown as Pick<CustomGesture, 'id' | 'name' | 'shape'>[]

describe('captureShape', () => {
  it('keeps evenly spread, rounded samples of a still shape', () => {
    const shape = saved(captureShape(hold('Y', 7), ASPECT))
    expect(shape).toHaveLength(SHAPE_SAMPLES)
    for (const v of shape) {
      expect(v).toHaveLength(STATIC_FEATURE_DIM)
      for (const x of v) expect(Math.round(x * 1000) / 1000).toBe(x)
    }
  })

  it.each(['A', 'L', 'I', 'Y'] as ShapeName[])('accepts the distinct shape %s', (shape) => {
    expect(captureShape(hold(shape, 11), ASPECT).ok).toBe(true)
  })

  it('accepts a small, jittery hand unless it often reads as a control', () => {
    expect(captureShape(hold('Y', 12, FAR), ASPECT).ok).toBe(true)
    expect(captureShape(hold('I', 12, FAR), ASPECT).ok).toBe(true)
    // Far away, the thumb of an A flickers into a fist, and an L's into 1 finger.
    expect(captureShape(hold('A', 12, FAR), ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.control('a fist') })
    expect(captureShape(hold('L', 12, FAR), ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.control('1 finger') })
  })

  it('needs a hand in most frames', () => {
    expect(captureShape([], ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.noHand })
    expect(captureShape(new Timeline({ aspect: ASPECT }).none(1100).frames, ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.noHand })
    const glimpse = hold('Y', 7).map((f, i) => (i < 15 ? f : { ...f, hands: [] }))
    expect(captureShape(glimpse, ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.noHand })
  })

  it('refuses a shape that changes, or changes and comes back', () => {
    const changed = performHolds(
      [
        { shape: 'L', holdMs: 450 },
        { shape: 'Y', holdMs: 500 }
      ],
      { random: rng(3), aspect: ASPECT, transitionMs: 150 }
    )
    expect(captureShape(changed, ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.moved })
    const wobble = performHolds(
      [
        { shape: 'Y', holdMs: 300 },
        { shape: 'I', holdMs: 300 },
        { shape: 'Y', holdMs: 300 }
      ],
      { random: rng(4), aspect: ASPECT, transitionMs: 120 }
    )
    expect(captureShape(wobble, ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.moved })
  })

  it.each([
    ['fist', 'a fist'],
    ['thumbsUp', 'a thumbs-up'],
    ['openPalm', 'an open palm'],
    ['peace', '2 fingers'],
    ['one', '1 finger'],
    ['twoTogether', '2 fingers'],
    ['three', '3 fingers'],
    ['four', '4 fingers']
  ] as [PoseName, string][])('refuses the control gesture %s', (name, reads) => {
    expect(captureShape(pose({ pose: name }), ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.control(reads) })
  })

  it('refuses a resting hand', () => {
    expect(captureShape(pose({ pose: 'relaxed' }), ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.loose })
    expect(captureShape(pose({ pose: 'aslC' }), ASPECT)).toEqual({ ok: false, reason: CAPTURE_REASONS.loose })
  })

  it('refuses a shape too close to a saved one, by name', () => {
    const existing = [
      { id: 'g2', name: 'Gesture 2', shape: saved(captureShape(hold('Y', 7), ASPECT)) }
    ]
    expect(captureShape(hold('Y', 8), ASPECT, { gestures: existing })).toEqual({ ok: false, reason: CAPTURE_REASONS.taken('Gesture 2') })
    expect(captureShape(hold('L', 8), ASPECT, { gestures: existing }).ok).toBe(true)
  })

  it('ignores malformed saved shapes', () => {
    expect(captureShape(hold('Y', 8), ASPECT, { gestures: MALFORMED }).ok).toBe(true)
  })

  it('refuses a shape that reads as a taught letter, at any sensitivity', () => {
    const templates = [...taughtLetter('Y'), ...taughtLetter('A')]
    expect(captureShape(hold('Y', 8), ASPECT, { templates })).toEqual({ ok: false, reason: CAPTURE_REASONS.letter('Y') })
    for (const sensitivity of Object.values(SENSITIVITY)) {
      expect(captureShape(hold('Y', 9), ASPECT, { templates, sensitivity })).toEqual({ ok: false, reason: CAPTURE_REASONS.letter('Y') })
    }
    // Other letters, and words, are no rivals.
    expect(captureShape(hold('I', 8), ASPECT, { templates }).ok).toBe(true)
    expect(captureShape(hold('L', 8), ASPECT, { templates }).ok).toBe(true)
    const words = taughtLetter('Y').map((t) => ({ ...t, kind: 'word' as const }))
    expect(captureShape(hold('Y', 8), ASPECT, { templates: words }).ok).toBe(true)
  })

  it('records the larger hand when both are up', () => {
    const fist = makeHand({ pose: 'fist', x: 0.2, size: 0.08 }, { aspect: ASPECT })
    const frames = hold('Y', 7).map((f) => ({ ...f, hands: [fist, ...f.hands] }))
    expect(captureShape(frames, ASPECT).ok).toBe(true)
  })
})

describe('shapeMatcher', () => {
  const Y = saved(captureShape(hold('Y', 7), ASPECT))
  const L = saved(captureShape(hold('L', 7), ASPECT))
  const hand = (shape: ShapeName, seed: number, extra: HoldOptions = {}) => hold(shape, seed, extra)[15].hands[0]

  it('is null without any recorded shape', () => {
    expect(shapeMatcher([])).toBeNull()
    expect(shapeMatcher([{ id: 'empty', shape: [] }])).toBeNull()
  })

  it('ignores malformed samples from a hand-edited file', () => {
    expect(shapeMatcher(MALFORMED)).toBeNull()
    const match = shapeMatcher([...MALFORMED, { id: 'y', shape: Y }], ASPECT)
    expect(match?.(hand('Y', 20))).toEqual({ id: 'y' })
  })

  it('tells saved shapes apart and matches nothing else', () => {
    const match = shapeMatcher(
      [
        { id: 'y', shape: Y },
        { id: 'l', shape: L }
      ],
      ASPECT
    )!
    expect(match(hand('Y', 21))).toEqual({ id: 'y' })
    expect(match(hand('L', 21))).toEqual({ id: 'l' })
    expect(match(hand('Y', 22, { handedness: 'Left' }))).toEqual({ id: 'y' })
    expect(match(hand('I', 21))).toBeNull()
    expect(match(makeHand({ pose: 'relaxed' }, { aspect: ASPECT }))).toBeNull()
  })

  it('drives the engine: a saved shape held still fires its id, and a peace-sign hand fires nothing', () => {
    const engine = new GestureEngine({ aspect: ASPECT })
    engine.setActive(new Set(['shape']))
    engine.setShapeMatcher(shapeMatcher([{ id: 'y', shape: Y }], ASPECT))
    const fired = [...hold('Y', 30, {}, 1500), ...pose({ pose: 'peace' }, 1500).map((f) => ({ ...f, t: f.t + 2000 }))].flatMap((f) =>
      engine.update(f)
    )
    expect(fired).toEqual([{ gesture: 'shape', shapeId: 'y' }])
  })
})

/*
 * Calibration of SHAPE_MATCH_DISTANCE on the synthetic signer: a shape captured once is made
 * again 20 times with a real signer's variation. A hold counts when at least 80% of its frames
 * match (the engine's hold survives a 2-frame flicker).
 */
describe('shape calibration', () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => 100 + i)
  const DISTINCT: ShapeName[] = ['A', 'L', 'I', 'Y']

  function heldShare(match: NonNullable<ReturnType<typeof shapeMatcher>>, shape: ShapeName, extra: HoldOptions = {}): number {
    const held = SEEDS.filter((seed) => {
      const hands = hold(shape, seed, extra, 1000).flatMap((f) => f.hands)
      return hands.filter((h) => match(h)).length >= 0.8 * hands.length
    })
    return held.length / SEEDS.length
  }

  const captures = DISTINCT.flatMap((shape) =>
    [7, 8, 9].map((seed) => ({ shape, match: shapeMatcher([{ id: shape, shape: saved(captureShape(hold(shape, seed), ASPECT)) }], ASPECT)! }))
  )
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

  it('matches most later holds of the same shape', () => {
    const same = captures.map(({ shape, match }) => heldShare(match, shape))
    const otherHand = captures.map(({ shape, match }) => heldShare(match, shape, { handedness: 'Left' }))
    const far = captures.map(({ shape, match }) => heldShare(match, shape, FAR))
    expect(Math.min(...same)).toBeGreaterThanOrEqual(0.8)
    expect(mean(otherHand)).toBeGreaterThanOrEqual(0.7)
    expect(mean(far)).toBeGreaterThanOrEqual(0.6)
  }, 20_000)

  it('never matches a different handshape or a resting hand', () => {
    const others = (Object.keys(SHAPES) as ShapeName[]).map((shape) => ({
      shape,
      hands: [400, 401, 402].flatMap((seed) => hold(shape, seed, {}, 600)).flatMap((f) => f.hands)
    }))
    const resting = (['relaxed', 'aslC', 'five', 'openPalm'] as PoseName[]).map((p) => makeHand({ pose: p }, { aspect: ASPECT }))
    for (const { shape, match } of captures) {
      for (const other of others.filter((o) => o.shape !== shape)) expect(other.hands.filter((h) => match(h))).toHaveLength(0)
      expect(resting.filter((h) => match(h))).toHaveLength(0)
    }
  }, 20_000)
})
