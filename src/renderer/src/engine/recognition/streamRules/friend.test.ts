import { describe, expect, it } from 'vitest'
import type { Handedness } from '@shared/types'
import { makeHand, seededRandom, Timeline, type HandSpec, type PoseName } from '../../gestures/synthetic'
import type { FrameSample, HandSample } from '../../types'
import { controlGestureClips, replayStream } from '../streamEval'
import { performSign, poseLandmarks, rng, WORDS, type Handshape } from '../synthetic'
import { STREAM_RULES } from '.'
import { friend } from './friend'
import { ALL_RULES, handsOf, indexOnly } from './twoHandSigns'
import type { StreamRule } from './types'

/*
 * FRIEND on synthetic signers: two X hands hook, come apart as they flip, and hook again. It fires
 * once, on the second hook, for either handedness. The same hands without the release, without
 * the second hook, with one hand, with one hand still, or in another handshape (fists, flat
 * hands, H hands, MEETING's flat O) fire nothing; neither do the control gestures. TIME does not
 * fire on FRIEND (an index hooked onto the other hand's index is not a tap on the wrist).
 * friend.eval.test.ts has the numbers on real signers.
 */

const ASPECT = 4 / 3
const DT = 1000 / 30
/** Hand length (wrist to middle knuckle) as a fraction of the frame height. */
const SIZE = 0.15

/** X: the index hooked (it reads half bent), the other fingers closed. */
const X: Handshape = { curls: [0.4, 1, 1, 1], spread: 0.2, thumbOut: 0.3, thumbFlex: 0.8 }
const FIST: Handshape = { curls: [1, 1, 1, 1], spread: 0.2, thumbOut: 0.2, thumbFlex: 0.9 }
const FLAT: Handshape = { curls: [0, 0, 0, 0], spread: 0.2, thumbOut: 0.1, thumbFlex: 0.7 }
/** H: index and middle out together (NAME, CHAIR). */
const H: Handshape = { curls: [0, 0, 1, 1], spread: 0.2, thumbOut: 0.2, thumbFlex: 0.9 }

/** One hand in one frame: its shape, turn about the finger axis, and where its index DIP sits (hand lengths from the centre). */
interface Part {
  shape: Handshape
  handedness: Handedness
  /** Fingers along +x (90) or -x (-90) in the image. */
  roll: number
  /** Turn about the finger axis: palm down and palm up are ±80. */
  yaw: number
  at: [number, number]
}

interface Signer {
  random: () => number
  centre: [number, number]
  size: number
  /** Tempo: phase durations are multiplied by this. */
  tempo: number
}

function signer(seed: number): Signer {
  const random = rng(seed)
  const j = (): number => random() * 2 - 1
  return { random, centre: [0.5 + 0.05 * j(), 0.6 + 0.04 * j()], size: SIZE * (1 + 0.15 * j()), tempo: 1 + 0.15 * j() }
}

function render(p: Part, s: Signer): HandSample {
  const raw = poseLandmarks({ shape: p.shape, handedness: p.handedness, x: 0.5, y: 0.5, size: s.size, roll: p.roll, pitch: 0, yaw: p.yaw }, ASPECT)
  const dx = s.centre[0] + (p.at[0] * s.size) / ASPECT - raw[7].x
  const dy = s.centre[1] + p.at[1] * s.size - raw[7].y
  const n = (): number => 0.002 * (s.random() + s.random() - 1)
  return { handedness: p.handedness, score: 0.95, landmarks: raw.map((q) => ({ x: q.x + dx + n(), y: q.y + dy + n(), z: q.z })) }
}

/** A clip built phase by phase at 30 fps: each phase gives the hands' parts at progress u (0..1). */
class Clip {
  readonly frames: FrameSample[] = []
  /** Start time of each phase, by name. */
  readonly at: Record<string, number> = {}
  constructor(readonly s: Signer) {}
  phase(name: string, ms: number, parts: (u: number) => Part[]): this {
    const n = Math.max(1, Math.round((ms * this.s.tempo) / DT))
    this.at[name] = 1000 + this.frames.length * DT
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 1 : i / (n - 1)
      this.frames.push({ t: 1000 + this.frames.length * DT, hands: parts(u).map((p) => render(p, this.s)) })
    }
    return this
  }
}

const ease = (u: number): number => u * u * (3 - 2 * u)
const mix = (a: number, b: number, u: number): number => a + (b - a) * u
const lerp = (a: [number, number], b: [number, number], u: number): [number, number] => [mix(a[0], b[0], ease(u)), mix(a[1], b[1], ease(u))]

/**
 * The right-handed FRIEND: the right hand (image left, fingers to +x) hooks over the left (image
 * right, fingers to -x), the hands come apart as they turn over, and hook again with the left on
 * top. `mirror` is the left-handed signer; the options leave parts of the sign out.
 */
function friendClip(seed: number, o: { mirror?: boolean; shape?: Handshape; secondHook?: boolean; still?: 'a' | 'b'; only?: 'a' | 'b' } = {}): Clip {
  const shape = o.shape ?? X
  const m = o.mirror ? -1 : 1
  const part = (side: 'a' | 'b', at: [number, number], yaw: number): Part => ({
    shape,
    handedness: (side === 'a') !== !!o.mirror ? 'Right' : 'Left',
    roll: side === 'a' ? 90 * m : -90 * m,
    yaw: side === 'a' ? yaw * m : -yaw * m,
    at: [at[0] * m, at[1]]
  })
  const hookA: [number, number] = [0, -0.1]
  const hookB: [number, number] = [0, 0.1]
  const both = (a: [number, number], b: [number, number], yaw: number): Part[] => {
    const still = { a: part('a', hookA, -80), b: part('b', hookB, -80) }
    const parts = [o.still === 'a' ? still.a : part('a', a, yaw), o.still === 'b' ? still.b : part('b', b, yaw)]
    return o.only ? parts.filter((_, i) => (i === 0) === (o.only === 'a')) : parts
  }
  const clip = new Clip(signer(seed))
  clip.phase('rest', 300, () => [])
  clip.phase('approach', 300, (u) => both(lerp([-1.6, 0.2], hookA, u), lerp([1.6, 0.2], hookB, u), -80))
  clip.phase('hook1', 250, () => both(hookA, hookB, -80))
  // Apart and over: the right hand swings out and down, the left out and up, both turning over.
  const swing = (u: number, side: 1 | -1): [number, number] => [side * 0.8 * Math.sin(Math.PI * u), mix(-0.1 * side, 0.1 * side, ease(u))]
  if (o.secondHook === false) {
    clip.phase('flip', 400, (u) => both(swing(u / 2, -1), swing(u / 2, 1), mix(-80, 0, u)))
    clip.phase('apart', 800, () => both(swing(0.5, -1), swing(0.5, 1), 0))
    return clip
  }
  clip.phase('flip', 400, (u) => both(swing(u, -1), swing(u, 1), mix(-80, 80, ease(u))))
  clip.phase('hook2', 400, () => both([0, 0.1], [0, -0.1], 80))
  clip.phase('lower', 300, (u) => both(lerp([0, 0.1], [-1.6, 1.5], u), lerp([0, -0.1], [1.6, 1.5], u), 80))
  return clip
}

const words = (frames: FrameSample[], rules: readonly StreamRule[] = [friend]): string[] =>
  replayStream({ name: 'synthetic', gloss: 'synthetic', aspect: ASPECT, frames }, { rules }).map((h) => h.word)

const time = ALL_RULES.find((r) => r.word === 'time')!

describe('the X hand (index only, hooked or straight)', () => {
  it('reads an X and a 1 as index only; a fist, a flat hand, an H and a Y not', () => {
    const shape = (h: Handshape): boolean => {
      const s = signer(1)
      return handsOf({ t: 0, hands: [render({ shape: h, handedness: 'Right', roll: 90, yaw: -80, at: [0, 0] }, s)] }, ASPECT).every(indexOnly)
    }
    expect(shape(X)).toBe(true)
    expect(shape({ ...X, curls: [0, 1, 1, 1] })).toBe(true)
    expect(shape(FIST)).toBe(false)
    expect(shape(FLAT)).toBe(false)
    expect(shape(H)).toBe(false)
    expect(shape({ curls: [1, 1, 1, 0], spread: 1, thumbOut: 1, thumbFlex: 0 })).toBe(false)
  })
})

describe('FRIEND on synthetic signers', () => {
  it('fires once, on the second hook', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const clip = friendClip(seed)
      const hits = replayStream({ name: 's', gloss: 'FRIEND', aspect: ASPECT, frames: clip.frames }, { rules: [friend] })
      expect(hits.map((h) => h.word), `seed ${seed}`).toEqual(['friend'])
      expect(hits[0].t, `seed ${seed}`).toBeGreaterThanOrEqual(clip.at.hook2 - 3 * DT)
      expect(hits[0].t, `seed ${seed}`).toBeLessThan(clip.at.hook2 + 300)
    }
  })

  it('works for a left-handed signer (the mirror image)', () => {
    for (const seed of [1, 2, 3]) expect(words(friendClip(seed, { mirror: true }).frames), `seed ${seed}`).toEqual(['friend'])
  })

  it('is FRIEND among all the stream rules, not TIME', () => {
    for (const seed of [1, 2, 3]) expect(words(friendClip(seed).frames, STREAM_RULES), `seed ${seed}`).toEqual(['friend'])
  })

  it('TIME alone does not fire on it (the index hooks the other index, not the wrist)', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) expect(words(friendClip(seed).frames, [time]), `seed ${seed}`).toEqual([])
  })
})

describe('what FRIEND must not fire on', () => {
  it('one hook only: held, or followed by the hands coming apart', () => {
    for (const seed of [1, 2, 3]) {
      const held = friendClip(seed, { secondHook: false })
      expect(words(held.frames), `seed ${seed}`).toEqual([])
      const clip = new Clip(signer(seed))
      clip.phase('approach', 300, (u) => [
        { shape: X, handedness: 'Right', roll: 90, yaw: -80, at: lerp([-1.6, 0.2], [0, -0.1], u) },
        { shape: X, handedness: 'Left', roll: -90, yaw: 80, at: lerp([1.6, 0.2], [0, 0.1], u) }
      ])
      clip.phase('hold', 1500, () => [
        { shape: X, handedness: 'Right', roll: 90, yaw: -80, at: [0, -0.1] },
        { shape: X, handedness: 'Left', roll: -90, yaw: 80, at: [0, 0.1] }
      ])
      expect(words(clip.frames), `seed ${seed}`).toEqual([])
    }
  })

  it('one hand making its half of the movement', () => {
    for (const only of ['a', 'b'] as const) expect(words(friendClip(1, { only }).frames), only).toEqual([])
  })

  it('one hand tapping twice onto the other, which holds still (TIME-like taps)', () => {
    for (const still of ['a', 'b'] as const) {
      for (const seed of [1, 2, 3]) expect(words(friendClip(seed, { still }).frames, [friend, time]), `${still} still, seed ${seed}`).toEqual([])
    }
  })

  it('the same movement in other handshapes: fists (WORK), flat hands, H hands (NAME)', () => {
    for (const shape of [FIST, FLAT, H]) {
      for (const seed of [1, 2, 3]) expect(words(friendClip(seed, { shape }).frames), `seed ${seed}`).toEqual([])
    }
  })

  it('MEETING: open hands coming together into flat O, once', () => {
    for (const seed of [1, 2, 3]) {
      const frames = performSign(WORDS.MEETING, { random: rng(seed), aspect: ASPECT, variation: 0.5 })
      expect(words(frames), `seed ${seed}`).toEqual([])
    }
  })

  it("the app's control gestures: held shapes, one hand or both, swipes, and the cancel fist", () => {
    const clips: FrameSample[][] = controlGestureClips().map((c) => c.frames)
    let seed = 1
    const poses: PoseName[] = ['openPalm', 'five', 'fist', 'thumbsUp', 'one', 'peace', 'twoTogether', 'three', 'threeAsl', 'four', 'relaxed']
    for (const pose of poses) {
      const tl = new Timeline({ fps: 30, seed: seed++, aspect: ASPECT })
      clips.push(tl.hold(1600, { pose, handedness: 'Right', x: 0.42, y: 0.6, noise: 0.002 }, { pose, handedness: 'Left', x: 0.58, y: 0.6, noise: 0.002 }).frames)
    }
    // Both index fingers up, tapped together twice (a 1 with each hand).
    const ones = new Timeline({ fps: 30, seed: seed++, aspect: ASPECT })
    const one = (x: number, handedness: Handedness): HandSpec => ({ pose: 'one', handedness, x, y: 0.6, noise: 0.002 })
    for (let k = 0; k < 2; k++) ones.hold(250, one(0.47, 'Right'), one(0.53, 'Left')).hold(250, one(0.38, 'Right'), one(0.62, 'Left'))
    clips.push(ones.frames)
    // A hand closing into a fist (cancel) beside the other hand.
    for (const from of ['openPalm', 'one'] as PoseName[]) {
      const tl = new Timeline({ fps: 30, seed: seed++, aspect: ASPECT })
      const at = (u: number): HandSpec => ({ pose: u < 0.5 ? from : 'fist', handedness: 'Right', x: 0.45, y: 0.6, noise: 0.002 })
      const other: HandSpec = { pose: 'one', handedness: 'Left', x: 0.55, y: 0.6, noise: 0.002 }
      tl.segment(400, () => [at(0), other]).segment(500, (u) => [at(u), other]).segment(800, () => [at(1), other])
      clips.push(tl.frames)
    }
    const random = seededRandom(3)
    clips.push([0, 1, 2, 3].map((i) => ({ t: i * DT, hands: [makeHand({ pose: 'fist', x: 0.5, y: 0.6 }, { aspect: ASPECT, rng: random })] })))
    for (const [i, frames] of clips.entries()) {
      expect(words(frames), `clip ${i} of ${clips.length}`).toEqual([])
      expect(words(frames, STREAM_RULES).filter((w) => w === 'friend')).toEqual([])
    }
  })
})
