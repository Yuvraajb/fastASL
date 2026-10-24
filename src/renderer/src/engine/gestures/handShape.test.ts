import { describe, expect, it } from 'vitest'
import { analyzeHand, fingerCount, isFist, isFlatHand, isOpenPalm, isPeace, isThumbsUp, type HandShape } from './handShape'
import { makeHand, seededRandom, type HandSpec, type PoseName } from './synthetic'

interface Reading {
  palm: boolean
  fist: boolean
  thumbsUp: boolean
  peace: boolean
  count: number | null
}

const NOTHING: Reading = { palm: false, fist: false, thumbsUp: false, peace: false, count: null }

function read(s: HandShape): Reading {
  return { palm: isOpenPalm(s), fist: isFist(s), thumbsUp: isThumbsUp(s), peace: isPeace(s), count: fingerCount(s) }
}

const shape = (spec: HandSpec, aspect = 1): HandShape => analyzeHand(makeHand(spec, { aspect }), aspect)

const EXPECTED: Record<PoseName, Reading> = {
  openPalm: { ...NOTHING, palm: true, count: 5 },
  five: { ...NOTHING, palm: true, count: 5 },
  fist: { ...NOTHING, fist: true },
  thumbsUp: { ...NOTHING, thumbsUp: true },
  one: { ...NOTHING, count: 1 },
  peace: { ...NOTHING, peace: true, count: 2 },
  twoTogether: { ...NOTHING, count: 2 },
  three: { ...NOTHING, count: 3 },
  threeAsl: { ...NOTHING, count: 3 },
  four: { ...NOTHING, count: 4 },
  relaxed: NOTHING,
  aslA: NOTHING,
  aslC: NOTHING
}
const POSES = Object.keys(EXPECTED) as PoseName[]

describe('analyzeHand', () => {
  it('measures palm size in frame-height units for any aspect ratio and orientation', () => {
    for (const aspect of [1, 4 / 3, 16 / 9]) {
      for (const size of [0.1, 0.18, 0.3]) {
        for (const roll of [0, 90]) {
          expect(shape({ pose: 'openPalm', size, roll }, aspect).palmSize).toBeCloseTo(size, 6)
        }
      }
    }
  })

  it('needs the aspect ratio to undo the horizontal squash of a wide source', () => {
    const sideways = makeHand({ pose: 'openPalm', size: 0.2, roll: 90 }, { aspect: 16 / 9 })
    expect(analyzeHand(sideways, 16 / 9).palmSize).toBeCloseTo(0.2, 6)
    expect(analyzeHand(sideways, 1).palmSize).toBeCloseTo((0.2 * 9) / 16, 6)
  })

  it('scores straight digits near 1, curled near 0 and a relaxed hand in between', () => {
    const open = shape({ pose: 'openPalm' }).extension
    const fist = shape({ pose: 'fist' }).extension
    const relaxed = shape({ pose: 'relaxed' }).extension
    for (const d of ['thumb', 'index', 'middle', 'ring', 'pinky'] as const) {
      expect(open[d]).toBeGreaterThan(0.9)
      expect(fist[d]).toBeLessThan(0.1)
    }
    for (const f of ['index', 'middle', 'ring', 'pinky'] as const) {
      expect(relaxed[f]).toBeGreaterThan(0.3)
      expect(relaxed[f]).toBeLessThan(0.7)
    }
  })

  it('reports the palm facing the camera as +1 and the back of the hand as -1, for both hands', () => {
    for (const handedness of ['Left', 'Right'] as const) {
      expect(shape({ pose: 'openPalm', handedness }).palmFacing).toBeGreaterThan(0.95)
      expect(shape({ pose: 'openPalm', handedness, yaw: 180 }).palmFacing).toBeLessThan(-0.95)
      expect(Math.abs(shape({ pose: 'openPalm', handedness, yaw: 90 }).palmFacing)).toBeLessThan(0.1)
    }
  })

  it('reports the hand pointing direction in image space', () => {
    expect(shape({ pose: 'openPalm' }).pointing.y).toBeCloseTo(-1, 5)
    expect(shape({ pose: 'openPalm', roll: 90 }).pointing.x).toBeCloseTo(1, 5)
  })
})

describe('classifiers on canonical poses', () => {
  for (const pose of POSES) {
    for (const handedness of ['Left', 'Right'] as const) {
      it(`${pose} (${handedness})`, () => {
        expect(read(shape({ pose, handedness }))).toEqual(EXPECTED[pose])
      })
    }
  }
})

describe('classifiers under rotation, scale, aspect and jitter', () => {
  // 200 random variants per pose with MediaPipe-like jitter. Abstaining on a frame
  // is tolerated (the engine absorbs flickers); a wrong positive never is.
  for (const pose of POSES) {
    it(pose, () => {
      const rng = seededRandom(POSES.indexOf(pose) + 1)
      const between = (a: number, b: number): number => a + (b - a) * rng()
      let exact = 0
      for (let i = 0; i < 200; i++) {
        const aspect = [1, 4 / 3, 16 / 9][i % 3]
        const spec: HandSpec = {
          pose,
          handedness: i % 2 ? 'Left' : 'Right',
          x: between(0.3, 0.7),
          y: between(0.6, 0.85),
          size: between(0.1, 0.28),
          roll: between(-20, 20),
          yaw: between(-30, 30),
          pitch: between(-20, 20),
          noise: 0.002
        }
        const got = read(analyzeHand(makeHand(spec, { aspect, rng }), aspect))
        if (JSON.stringify(got) === JSON.stringify(EXPECTED[pose])) exact++
        else expect(got, `variant ${i}`).toEqual(NOTHING)
      }
      expect(exact).toBeGreaterThanOrEqual(194)
    })
  }
})

describe('confusable shapes', () => {
  it('thumbs-up is not a fist, even turned sideways', () => {
    for (const yaw of [0, 45, -45, 70]) {
      const s = shape({ pose: 'thumbsUp', yaw })
      expect(isThumbsUp(s)).toBe(true)
      expect(isFist(s)).toBe(false)
    }
  })

  it('ASL A (thumb alongside the fist) is neither thumbs-up nor fist', () => {
    const s = shape({ pose: 'aslA' })
    expect(isThumbsUp(s)).toBe(false)
    expect(isFist(s)).toBe(false)
  })

  it('a thumbs-down is not a thumbs-up (it reads as a fist: both mean "no")', () => {
    const s = shape({ pose: 'thumbsUp', roll: 180 })
    expect(isThumbsUp(s)).toBe(false)
    expect(isFist(s)).toBe(true)
  })

  it('an open palm is 5, not 4; four fingers with the thumb tucked is 4, not an open palm', () => {
    expect(fingerCount(shape({ pose: 'openPalm' }))).toBe(5)
    expect(isOpenPalm(shape({ pose: 'four' }))).toBe(false)
    expect(fingerCount(shape({ pose: 'four' }))).toBe(4)
  })

  it('separates V (peace) from U by finger spread; both count as 2', () => {
    expect(isPeace(shape({ pose: 'peace' }))).toBe(true)
    expect(isPeace(shape({ pose: 'twoTogether' }))).toBe(false)
    expect(fingerCount(shape({ pose: 'twoTogether' }))).toBe(2)
  })

  it('counts ASL 3 (thumb, index, middle) and W-style 3 alike', () => {
    expect(fingerCount(shape({ pose: 'threeAsl' }))).toBe(3)
    expect(fingerCount(shape({ pose: 'three' }))).toBe(3)
    expect(isPeace(shape({ pose: 'threeAsl' }))).toBe(false)
  })

  it('requires the open palm to be upright and facing the camera', () => {
    expect(isOpenPalm(shape({ pose: 'openPalm', roll: 180 }))).toBe(false)
    expect(isOpenPalm(shape({ pose: 'openPalm', roll: 90 }))).toBe(false)
    expect(isOpenPalm(shape({ pose: 'openPalm', yaw: 75 }))).toBe(false)
    expect(isOpenPalm(shape({ pose: 'openPalm', roll: 30, yaw: 30 }))).toBe(true)
  })

  it('accepts an open palm regardless of the handedness label (labels have been swapped between MediaPipe releases)', () => {
    const hand = makeHand({ pose: 'openPalm', handedness: 'Right' })
    expect(isOpenPalm(analyzeHand({ ...hand, handedness: 'Left' }))).toBe(true)
  })

  it('does not count fingers on a hand pointing down', () => {
    expect(fingerCount(shape({ pose: 'peace', roll: 180 }))).toBeNull()
    expect(fingerCount(shape({ pose: 'one', roll: 150 }))).toBeNull()
  })

  it('reads a C seen from the side as nothing', () => {
    expect(read(shape({ pose: 'aslC', yaw: 60 }))).toEqual(NOTHING)
  })
})

describe('isFlatHand (swipe hand shape)', () => {
  it('accepts open hands and rejects fists and pointing', () => {
    for (const pose of ['openPalm', 'five', 'four', 'three'] as const) expect(isFlatHand(shape({ pose }))).toBe(true)
    for (const pose of ['fist', 'one', 'peace', 'thumbsUp', 'aslA'] as const) expect(isFlatHand(shape({ pose }))).toBe(false)
  })
})
