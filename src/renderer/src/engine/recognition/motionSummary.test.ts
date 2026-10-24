import { describe, expect, it } from 'vitest'
import type { FrameSample } from '../types'
import { reversals, shapeName, summarizeMotion } from './motionSummary'
import { Segmenter, type Segment } from './segmenter'
import { performSign, rng, UNKNOWN, WORDS, type SignSpec } from './synthetic'

const ASPECT = 4 / 3

/** The movement the segmenter cuts out of one clean performance (hands already up, no variation). */
function movement(spec: SignSpec, seed = 3): Extract<Segment, { kind: 'dynamic' }> {
  const frames = performSign(spec, { random: rng(seed), variation: 0, aspect: ASPECT, t0: 0 })
  const segmenter = new Segmenter({}, ASPECT)
  const found = frames.flatMap((f) => segmenter.push(f)).find((s) => s.kind === 'dynamic')
  if (found?.kind !== 'dynamic') throw new Error('no movement')
  return found
}

const summary = (spec: SignSpec): string => {
  const m = movement(spec)
  return summarizeMotion(m.frames, ASPECT, m.durationMs)
}

describe('summarizeMotion', () => {
  it('one hand: where it is, its handshape, which way it went (signer’s view) and how far, and the duration', () => {
    expect(summary(WORDS.HELLO)).toBe(
      "0.8 s, one hand, on the signer's right, at mid height in the frame.\n" +
        'Hand: flat hand, four fingers extended (B) throughout. Moves toward the signer\'s right 2.9 hand lengths.'
    )
  })

  it('a handshape that changes is given at the start and the end', () => {
    expect(summary(WORDS.SEND)).toContain('starts fist, ends open hand, all five fingers extended. Moves up')
    expect(summary(WORDS.NO)).toContain('starts index and middle extended (V or U), ends fist. Moves down')
  })

  it('names circles, repeats and staying in place', () => {
    expect(summary(WORDS.PLAY)).toContain('thumb and pinky extended (Y) throughout. Moves in a circle')
    expect(summary(WORDS.YES)).toContain('fist throughout. Moves down 0.6 hand lengths, then back, repeated: 4 strokes up and down.')
    expect(summary(WORDS.MUSIC)).toContain('repeated: 4 strokes side to side')
    expect(summary(WORDS.TIME)).toContain('Stays in place (0.3 hand lengths).')
  })

  it('two hands: the one that moves more first, each by the side it is on, and whether they come together', () => {
    const text = summary(WORDS.MEETING)
    expect(text.split('\n')).toEqual([
      '0.7 s, two hands that come together.',
      "Signer's right hand (moves more): starts open hand, all five fingers extended, ends fist. Moves toward the signer's left 1.2 hand lengths.",
      "Signer's left hand: starts open hand, all five fingers extended, ends fist. Moves toward the signer's right 1.2 hand lengths."
    ])
    expect(summary(UNKNOWN.twoHandSwing)).toMatch(/^1\.0 s, two hands\.\n/)
  })

  it('follows a hand by position, so a flickering Left/Right label is still one hand', () => {
    const m = movement(WORDS.HELLO)
    const flicker: FrameSample[] = m.frames.map((f, i) => ({
      ...f,
      hands: f.hands.map((h) => ({ ...h, handedness: i % 3 === 0 ? 'Left' : 'Right' }))
    }))
    expect(summarizeMotion(flicker, ASPECT, m.durationMs)).toMatch(/^0\.8 s, one hand, on the signer's right/)
  })

  it('image +x is the signer’s left (the camera image is not mirrored)', () => {
    const toImageRight: SignSpec = { durationMs: 700, hands: [{ handedness: 'Right', shape: 'B', path: (u) => [3 * u, 0] }] }
    expect(summary(toImageRight)).toContain("Moves toward the signer's left 2.9 hand lengths")
  })

  it('says so when no hand was tracked', () => {
    expect(summarizeMotion([{ t: 0, hands: [] }, { t: 500, hands: [] }], ASPECT)).toBe('0.5 s, no hands tracked.')
  })
})

describe('shapeName', () => {
  const state = (extended: string[], bent: string[] = []) =>
    Object.fromEntries(
      ['thumb', 'index', 'middle', 'ring', 'pinky'].map((d) => [d, extended.includes(d) ? 'extended' : bent.includes(d) ? 'partial' : 'folded'])
    ) as Parameters<typeof shapeName>[0]

  it('names the common handshapes with the ASL shape they resemble', () => {
    expect(shapeName(state(['thumb', 'index', 'middle', 'ring', 'pinky']))).toBe('open hand, all five fingers extended')
    expect(shapeName(state([]))).toBe('fist')
    expect(shapeName(state(['thumb', 'pinky']))).toBe('thumb and pinky extended (Y)')
    expect(shapeName(state(['thumb', 'index', 'pinky']))).toBe('thumb, index and pinky extended (I love you)')
    expect(shapeName(state([], ['index', 'middle', 'ring', 'pinky']))).toBe('curved hand, fingers bent (C or claw)')
  })

  it('lists other combinations, and bent fingers after the name', () => {
    expect(shapeName(state(['middle', 'ring']))).toBe('middle and ring extended')
    expect(shapeName(state(['index', 'middle', 'ring', 'pinky'], ['thumb']))).toBe('flat hand, four fingers extended (B), thumb bent')
  })
})

describe('reversals', () => {
  it('counts turns of at least half a hand length each way, not jitter', () => {
    expect(reversals([0, 1, 0, 1, 0])).toBe(3)
    expect(reversals([0, 0.2, 0, 0.2, 0, 0.2])).toBe(0)
    expect(reversals([0, 0.3, 0.6, 0.9, 0.5, 0.1])).toBe(1)
    expect(reversals([])).toBe(0)
  })
})
