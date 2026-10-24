import { describe, expect, it } from 'vitest'
import type { Landmark } from '@shared/types'
import type { FrameSample, HandSample } from '../types'
import { citizenInput, CITIZEN_FRAMES, CITIZEN_KEYPOINTS, downsample, hasFace, hasPose, islrInput, ISLR_POINTS, signerHands } from './inputs'
import { CITIZEN_PAD, ISLR_PAD, padded } from './signModel'

const points = (n: number, x: number, y = 0.5, z = 0): Landmark[] => Array.from({ length: n }, (_, i) => ({ x: x + i * 1e-3, y, z }))
const hand = (handedness: 'Left' | 'Right', x: number): HandSample => ({ landmarks: points(21, x), handedness, score: 0.9 })
/** The value at (frame t, point p, coordinate c) of a [T, 543, 3] input. */
const at = (data: Float32Array, t: number, p: number, c = 0): number => data[(t * ISLR_POINTS + p) * 3 + c]

describe('signerHands: HandLandmarker labels a raw frame as if mirrored', () => {
  it("puts the hand labelled 'Left' in the signer's right-hand slot, and 'Right' in the left", () => {
    const left = hand('Left', 0.3)
    const right = hand('Right', 0.7)
    expect(signerHands([left])).toEqual({ right: left, left: null })
    expect(signerHands([right])).toEqual({ right: null, left: right })
    expect(signerHands([right, left])).toEqual({ right: left, left: right })
  })

  it("tells two same-labelled hands apart by position: the one on the image's left is the signer's right", () => {
    const a = hand('Left', 0.7)
    const b = hand('Left', 0.2)
    expect(signerHands([a, b])).toEqual({ right: b, left: a })
  })

  it('has no hands for an empty frame', () => {
    expect(signerHands([])).toEqual({ right: null, left: null })
  })
})

describe('islrInput: [T, 543, 3] in the Kaggle layout', () => {
  const frames: FrameSample[] = [
    { t: 0, hands: [hand('Left', 0.3)], face: points(478, 0.4, 0.2, -0.01) },
    { t: 33, hands: [hand('Left', 0.31), hand('Right', 0.7)] },
    { t: 66, hands: [] }
  ]

  it('fills the face (first 468 of 478 points), the signer’s right hand at 522-542 and left hand at 468-488', () => {
    const x = islrInput(frames)
    expect(x.length).toBe(3 * ISLR_POINTS * 3)
    expect(at(x, 0, 0)).toBeCloseTo(0.4)
    expect(at(x, 0, 467)).toBeCloseTo(0.4 + 467e-3)
    expect(at(x, 0, 0, 2)).toBeCloseTo(-0.01)
    expect(at(x, 0, 522)).toBeCloseTo(0.3)
    expect(at(x, 0, 542)).toBeCloseTo(0.32)
    expect(at(x, 1, 522)).toBeCloseTo(0.31)
    expect(at(x, 1, 468)).toBeCloseTo(0.7)
  })

  it('leaves missing points NaN: no face, the other hand, the pose, a frame with no hands', () => {
    const x = islrInput(frames)
    expect(at(x, 1, 0)).toBeNaN() // no face in frame 1
    expect(at(x, 0, 468)).toBeNaN() // only one hand in frame 0
    for (let p = 489; p < 522; p++) expect(at(x, 1, p)).toBeNaN() // pose is unused
    for (let p = 0; p < ISLR_POINTS; p++) expect(at(x, 2, p)).toBeNaN()
  })

  it('swapped puts each hand in the other slot', () => {
    const x = islrInput(frames, true)
    expect(at(x, 0, 468)).toBeCloseTo(0.3)
    expect(at(x, 0, 522)).toBeNaN()
    expect(at(x, 1, 522)).toBeCloseTo(0.7)
    expect(at(x, 1, 468)).toBeCloseTo(0.31)
  })

  it('says whether a face was seen', () => {
    expect(hasFace(frames)).toBe(true)
    expect(hasFace(frames.slice(1))).toBe(false)
  })
})

describe('padded: context frames around a movement', () => {
  const frames = Array.from({ length: 40 }, (_, t): FrameSample => ({ t: t * 33, hands: [] }))

  it('gives the Kaggle model 5 frames each side and ASL Citizen 15 before and 9 after, cut to what there is', () => {
    const w = { frames, start: 20, end: 30 }
    expect(padded(w, ISLR_PAD).map((f) => f.t / 33)).toEqual(Array.from({ length: 21 }, (_, i) => 15 + i))
    const around = padded(w, CITIZEN_PAD)
    expect([around[0].t / 33, around[around.length - 1].t / 33]).toEqual([5, 39])
    const early = padded({ frames, start: 2, end: 37 }, CITIZEN_PAD)
    expect([early[0].t / 33, early[early.length - 1].t / 33]).toEqual([0, 39])
  })
})

describe('citizenInput: [2, 128, 27] as ASL Citizen prepares a clip', () => {
  const V = CITIZEN_KEYPOINTS.length
  const pose = (dx = 0): Landmark[] => {
    const p = points(33, 0.5 + dx, 0.6)
    p[11] = { x: 0.6 + dx, y: 0.6, z: 0 } // the signer's left shoulder (image right)
    p[12] = { x: 0.4 + dx, y: 0.6, z: 0 }
    p[0] = { x: 0.5 + dx, y: 0.3, z: 0 } // nose
    return p
  }

  it('normalizes by the shoulder centre and width over all 128 frames, zero padding included', () => {
    const frames: FrameSample[] = Array.from({ length: 64 }, (_, t) => ({ t, hands: [hand('Left', 0.45)], pose: pose() }))
    const x = citizenInput(frames)
    expect(x.length).toBe(2 * CITIZEN_FRAMES * V)
    // Half the frames are padding: centre (0.25, 0.3), width 0.1.
    const nose = (t: number, c: number): number => x[c * CITIZEN_FRAMES * V + t * V]
    expect(nose(0, 0)).toBeCloseTo((0.5 - 0.25) / 0.1, 4)
    expect(nose(0, 1)).toBeCloseTo((0.3 - 0.3) / 0.1, 4)
    // A padded frame is the zero point, normalized the same way.
    expect(nose(100, 0)).toBeCloseTo(-0.25 / 0.1, 4)
    // The 'Left'-labelled hand is the signer's right: its wrist is keypoint 17 (raw point 54).
    expect(x[17]).toBeCloseTo((0.45 - 0.25) / 0.1, 4)
    expect(x[7]).toBeCloseTo((0 - 0.25) / 0.1, 4) // no left hand: zero before normalizing
  })

  it('keeps 128 frames of a longer movement by ASL Citizen’s stepping rule', () => {
    expect(downsample(Array.from({ length: 256 }, (_, i) => i), 128)).toEqual(Array.from({ length: 128 }, (_, i) => 2 * i))
    expect(downsample([1, 2, 3], 128)).toEqual([1, 2, 3])
    const frames: FrameSample[] = Array.from({ length: 200 }, (_, t) => ({ t, hands: [], pose: pose(t / 1000) }))
    expect(citizenInput(frames).length).toBe(2 * CITIZEN_FRAMES * V)
  })

  it('leaves coordinates unscaled when no shoulders were seen', () => {
    const frames: FrameSample[] = [{ t: 0, hands: [hand('Right', 0.3)] }]
    const x = citizenInput(frames)
    expect(x[7]).toBeCloseTo(0.3) // the signer's left wrist, raw
    expect(hasPose(frames)).toBe(false)
  })
})
