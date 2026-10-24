import { describe, expect, it } from 'vitest'
import { makeHand, seededRandom, Timeline } from './synthetic'

describe('synthetic hands', () => {
  it('produces 21 normalized landmarks with the wrist where requested', () => {
    const hand = makeHand({ pose: 'five', x: 0.4, y: 0.8 })
    expect(hand.landmarks).toHaveLength(21)
    expect(hand.landmarks[0]).toMatchObject({ x: 0.4, y: 0.8, z: 0 })
    for (const p of hand.landmarks) {
      expect(p.x).toBeGreaterThan(0)
      expect(p.x).toBeLessThan(1)
      expect(p.y).toBeGreaterThan(0)
      expect(p.y).toBeLessThan(1)
    }
  })

  it('puts the thumb on raw +x for a right palm facing the camera, and mirrors it for a left hand', () => {
    expect(makeHand({ pose: 'openPalm', handedness: 'Right' }).landmarks[4].x).toBeGreaterThan(0.5)
    expect(makeHand({ pose: 'openPalm', handedness: 'Left' }).landmarks[4].x).toBeLessThan(0.5)
  })

  it('is reproducible with a seed', () => {
    const a = makeHand({ pose: 'fist', noise: 0.003 }, { rng: seededRandom(42) })
    const b = makeHand({ pose: 'fist', noise: 0.003 }, { rng: seededRandom(42) })
    expect(a).toEqual(b)
  })

  it('emits frames at the requested rate and ends moves exactly on target', () => {
    const tl = new Timeline({ fps: 20, t0: 0 }).move(500, { pose: 'openPalm', x: 0.2 }, { x: 0.6 }).none(100)
    expect(tl.frames.map((f) => f.t)).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550])
    expect(tl.frames[9].hands[0].landmarks[0].x).toBeCloseTo(0.6, 9)
    expect(tl.frames.at(-1)?.hands).toEqual([])
  })
})
