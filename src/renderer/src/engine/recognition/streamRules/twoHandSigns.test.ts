import { describe, expect, it } from 'vitest'
import { Timeline, type HandSpec, type PoseName } from '../../gestures/synthetic'
import type { FrameSample } from '../../types'
import { performSign, rng, type HandMotion, type SignSpec } from '../synthetic'
import { ALL_RULES, strokeCount, TWO_HAND_RULES } from './twoHandSigns'
import type { StreamRule } from './types'

const ASPECT = 4 / 3

/**
 * Replays frames the way StreamingSignMatcher does: at most 1.5 s of history, rules in order, the
 * first to fire wins, then the history starts over; the same word waits 900 ms, any word 300 ms.
 */
function stream(frames: readonly FrameSample[], rules: readonly StreamRule[] = TWO_HAND_RULES, aspect = ASPECT): string[] {
  const words: string[] = []
  let history: FrameSample[] = []
  let lastFire = -Infinity
  const cooldown = new Map<string, number>()
  for (const f of frames) {
    history.push(f)
    while (history.length > 1 && f.t - history[0].t > 1500) history.shift()
    if (!f.hands.length) continue
    const ready = (w: string): boolean => f.t - lastFire >= 300 && f.t >= (cooldown.get(w) ?? -Infinity)
    const hit = rules.find((r) => ready(r.word) && r.fires(history, { aspect }))
    if (!hit) continue
    words.push(hit.word)
    lastFire = f.t
    cooldown.set(hit.word, f.t + 900)
    history = []
  }
  return words
}

const rule = (word: string): StreamRule => ALL_RULES.find((r) => r.word === word)!
const perform = (spec: SignSpec, seed = 1): FrameSample[] => performSign(spec, { random: rng(seed), aspect: ASPECT, variation: 0.5 })
const wave = (u: number, cycles: number): number => Math.sin(2 * Math.PI * cycles * u)

// The signer's right hand is labelled 'Right' (the app's tracker); it appears on the image left.
const R = 'Right' as const
const L = 'Left' as const

const SIGNS: Record<string, SignSpec> = {
  time: {
    durationMs: 600,
    hands: [
      // Pointing hand above, index angled down at the base wrist, tapping twice.
      { handedness: R, shape: 'ONE', roll: () => 140, offset: [-0.6, -1.3], path: (u) => [0, 0.45 * Math.abs(wave(u, 1))] },
      // Base: a fist, forearm across the body (fingers pointing sideways).
      { handedness: L, shape: 'S', roll: () => -90, offset: [0.3, 0.2], path: () => [0, 0] }
    ]
  },
  what: {
    durationMs: 1300,
    hands: [
      { handedness: R, shape: 'FIVE', pitch: () => 70, offset: [-2.5, 0], path: (u) => [0.5 * wave(u, 2.5), 0] },
      { handedness: L, shape: 'FIVE', pitch: () => 70, offset: [2.5, 0], path: (u) => [0.5 * wave(u, 2.5), 0] }
    ]
  },
  open: {
    durationMs: 600,
    hands: [
      { handedness: R, shape: 'B', offset: [-0.6, 0], path: (u) => [-1.6 * u, 0] },
      { handedness: L, shape: 'B', offset: [0.6, 0], path: (u) => [1.6 * u, 0] }
    ]
  },
  play: {
    durationMs: 800,
    hands: [
      { handedness: R, shape: 'Y', offset: [-1.8, 0], roll: (u) => 35 * wave(u, 2), path: () => [0, 0] },
      { handedness: L, shape: 'Y', offset: [1.8, 0], roll: (u) => -35 * wave(u, 2), path: () => [0, 0] }
    ]
  },
  email: {
    durationMs: 900,
    hands: [
      // The index, pointing sideways, slides through the base hand.
      { handedness: R, shape: 'ONE', roll: () => 90, offset: [-2.4, -0.1], path: (u) => [1.9 * u, 0] },
      // Base: a C, standing up, edge-on to the camera.
      { handedness: L, shape: 'C', yaw: () => 70, offset: [0.2, 0], path: () => [0, 0] }
    ]
  },
  please: {
    durationMs: 1400,
    hands: [
      // Flat hand on the chest, fingers across the body, circling (clockwise in the raw image for the right hand).
      { handedness: R, shape: 'B', roll: () => 90, offset: [0, 0], path: (u) => [0.6 * (Math.cos(2 * Math.PI * 1.5 * u) - 1), 0.6 * Math.sin(2 * Math.PI * 1.5 * u)] }
    ]
  }
}

describe('strokeCount', () => {
  it('counts monotonic runs of at least the amplitude', () => {
    expect(strokeCount([0, 1, 0, 1, 0], 0.5)).toBe(4)
    expect(strokeCount([0, 0.3, 0, 0.3], 0.5)).toBe(0)
    expect(strokeCount([0, 0.6, 0.5, 0.65, 0], 0.5)).toBe(2)
    expect(strokeCount([], 1)).toBe(0)
  })
})

describe('two-hand stream rules on synthetic signers', () => {
  it('lists every enabled word once, with a hand count that matches the sign', () => {
    const words = TWO_HAND_RULES.map((r) => r.word)
    expect(new Set(words).size).toBe(words.length)
    expect(words).toEqual(expect.arrayContaining(['time', 'what', 'open', 'play', 'email', 'please']))
    for (const r of TWO_HAND_RULES) expect(r.hands).toBe(r.word === 'please' ? 1 : 2)
  })

  for (const [word, spec] of Object.entries(SIGNS)) {
    it(`fires ${word.toUpperCase()} once, while it is being signed`, () => {
      for (const seed of [1, 2, 3]) {
        const frames = perform(spec, seed)
        expect(stream(frames), `seed ${seed}`).toEqual([word])
        // It commits during the movement, not after the hands come to rest.
        let t: number | null = null
        const r = rule(word)
        for (let k = 0; k < frames.length && t === null; k++) {
          const history = frames.slice(0, k + 1).filter((f) => frames[k].t - f.t <= 1500)
          if (frames[k].hands.length && r.fires(history, { aspect: ASPECT })) t = frames[k].t
        }
        expect(t).not.toBeNull()
        expect(t!).toBeLessThan(300 + spec.durationMs * 1.25 + 100)
      }
    })
  }

  it('works for a left-handed signer (the mirror image)', () => {
    const mirror = (spec: SignSpec): SignSpec => ({
      ...spec,
      hands: spec.hands.map((h): HandMotion => ({
        ...h,
        handedness: h.handedness === R ? L : R,
        offset: h.offset ? [-h.offset[0], h.offset[1]] : undefined,
        path: (u) => {
          const [x, y] = h.path(u)
          return [-x, y]
        },
        roll: h.roll ? (u) => -h.roll!(u) : undefined,
        yaw: h.yaw ? (u) => -h.yaw!(u) : undefined
      }))
    })
    for (const [word, spec] of Object.entries(SIGNS)) expect(stream(perform(mirror(spec))), word).toEqual([word])
  })
})

describe('what the two-hand rules must not fire on', () => {
  it('one-handed versions of the two-handed signs (a swipe, a shake, a twist, a tap in the air)', () => {
    for (const [word, spec] of Object.entries(SIGNS)) {
      if (word === 'please') continue
      for (const hand of spec.hands) {
        expect(stream(perform({ ...spec, hands: [hand] })), `${word} with only the ${hand.handedness} hand`).toEqual([])
      }
    }
  })

  it('the start of each sign held still (no movement, no word)', () => {
    for (const [word, spec] of Object.entries(SIGNS)) {
      const held: SignSpec = { durationMs: 1500, hands: spec.hands.map((h) => ({ ...h, path: () => [0, 0], roll: h.roll ? () => h.roll!(0) : undefined })) }
      expect(stream(perform(held)), word).toEqual([])
    }
  })

  it('OPEN backwards: two flat hands coming together', () => {
    const together: SignSpec = {
      durationMs: 600,
      hands: [
        { handedness: R, shape: 'B', offset: [-2.2, 0], path: (u) => [1.6 * u, 0] },
        { handedness: L, shape: 'B', offset: [2.2, 0], path: (u) => [-1.6 * u, 0] }
      ]
    }
    expect(stream(perform(together))).toEqual([])
  })

  it("PLEASE's circle the other way round (HAPPY's brushing loop)", () => {
    const happy: SignSpec = {
      durationMs: 1400,
      hands: [{ handedness: R, shape: 'B', roll: () => 90, path: (u) => [0.6 * (Math.cos(2 * Math.PI * 1.5 * u) - 1), -0.6 * Math.sin(2 * Math.PI * 1.5 * u)] }]
    }
    expect(stream(perform(happy))).toEqual([])
  })

  it('WHAT: a shake that goes on is WHAT and nothing else (the matcher cooldown spaces any repeat)', () => {
    const long: SignSpec = { ...SIGNS.what, durationMs: 3200, hands: SIGNS.what.hands.map((h) => ({ ...h, path: (u: number) => [0.5 * wave(u, 6), 0] as [number, number] })) }
    const words = stream(perform(long))
    expect(words[0]).toBe('what')
    expect(new Set(words)).toEqual(new Set(['what']))
  })

  it('OPEN: hands that jump apart between frames (a tracking glitch, a cut) are no opening', () => {
    const tl = new Timeline({ fps: 30, aspect: ASPECT })
    const b = (x: number, handedness: 'Left' | 'Right'): HandSpec => ({ pose: 'openPalm', handedness, x, y: 0.6, size: 0.15, noise: 0.002 })
    tl.hold(500, b(0.45, 'Right'), b(0.55, 'Left')).hold(500, b(0.2, 'Right'), b(0.8, 'Left'))
    expect(stream(tl.frames)).toEqual([])
  })

  it('the cancel gesture: a hand closing into a fist, moving toward the other hand or not, the other hand in view', () => {
    const clips: FrameSample[][] = []
    let seed = 100
    for (const from of ['openPalm', 'five', 'one', 'relaxed'] as PoseName[]) {
      for (const other of ['relaxed', 'openPalm', 'aslC', null] as (PoseName | null)[]) {
        for (const dx of [0, 0.12, 0.25]) {
          const tl = new Timeline({ fps: 30, seed: seed++, aspect: ASPECT })
          const still: HandSpec[] = other ? [{ pose: other, handedness: L, x: 0.68, y: 0.62, noise: 0.002 }] : []
          const at = (u: number): HandSpec => ({ pose: u < 0.5 ? from : 'fist', handedness: R, x: 0.35 + dx * u, y: 0.6, noise: 0.002 })
          tl.segment(400, () => [at(0), ...still])
          tl.segment(500, (u) => [at(u), ...still])
          tl.segment(800, () => [at(1), ...still])
          clips.push(tl.frames)
        }
      }
    }
    for (const frames of clips) expect(stream(frames, ALL_RULES)).toEqual([])
  })

  it("the app's control gestures: held shapes (one hand or both) and swipes, with or without the other hand in view", () => {
    const poses: PoseName[] = ['openPalm', 'five', 'fist', 'thumbsUp', 'one', 'peace', 'twoTogether', 'three', 'threeAsl', 'four', 'relaxed']
    const clips: FrameSample[][] = []
    let seed = 1
    for (const pose of poses) {
      const tl = (): Timeline => new Timeline({ fps: 30, seed: seed++, aspect: ASPECT })
      clips.push(tl().hold(1600, { pose, x: 0.5, y: 0.6, noise: 0.002 }).frames)
      clips.push(tl().hold(1600, { pose, handedness: R, x: 0.35, y: 0.6, noise: 0.002 }, { pose, handedness: L, x: 0.65, y: 0.6, noise: 0.002 }).frames)
    }
    for (const ms of [150, 250, 400]) {
      for (const [from, to] of [
        [{ x: 0.3, y: 0.6 }, { x: 0.7 }],
        [{ x: 0.7, y: 0.6 }, { x: 0.3 }],
        [{ x: 0.5, y: 0.8 }, { y: 0.3 }]
      ] as const) {
        const hand: HandSpec = { pose: 'openPalm', ...from, noise: 0.002 }
        const tl = new Timeline({ fps: 30, seed: seed++, aspect: ASPECT }).hold(300, hand).move(ms, hand, to)
        tl.move(ms + 100, { ...hand, ...to }, from).move(ms, hand, to)
        clips.push(tl.frames)
        // The same swipe with the other hand resting low in view.
        const idle: HandSpec = { pose: 'relaxed', handedness: L, x: 0.8, y: 0.9, noise: 0.002 }
        const two = new Timeline({ fps: 30, seed: seed++, aspect: ASPECT })
        two.segment(300, () => [hand, idle])
        two.segment(ms, (u) => [{ ...hand, x: from.x + ((('x' in to ? to.x : from.x) as number) - from.x) * u, y: from.y + ((('y' in to ? to.y : from.y) as number) - from.y) * u }, idle])
        two.segment(400, () => [{ ...hand, ...to }, idle])
        clips.push(two.frames)
      }
    }
    for (const frames of clips) expect(stream(frames, ALL_RULES)).toEqual([])
  })
})
