import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import { describe, expect, it } from 'vitest'
import type { FaceBox } from '../types'
import { emptyFrames, performSign, rng, syntheticFace, timeline, WORDS } from './synthetic'
import { RecognitionSession, type RecognitionEvent } from './session'

const ASPECT = 16 / 9

/** HELLO signed from the forehead (upper frame), the way a person would. */
const hello = (seed: number, center: [number, number] = [0.5, 0.35]) => (t0: number) =>
  performSign(WORDS.HELLO, { random: rng(seed), aspect: ASPECT, t0, center, restBeforeMs: 400, restAfterMs: 500 })

function run(parts: ((t0: number) => ReturnType<typeof performSign>)[], mode: 'command' | 'spell' = 'command', face?: FaceBox) {
  const session = new RecognitionSession({ aspect: ASPECT, dictionary: DEFAULT_DICTIONARY })
  session.setMode(mode)
  const events: { e: RecognitionEvent; t: number }[] = []
  for (const f of timeline(parts, 400)) for (const e of session.update(face ? { ...f, face: syntheticFace(face) } : f)) events.push({ e, t: f.t })
  return events
}

const tokens = (events: ReturnType<typeof run>) => events.flatMap(({ e }) => (e.type === 'token' ? [e.text] : []))

describe('lexicon: standard ASL signs with no recordings', () => {
  it('recognizes HELLO from the forehead with nothing taught', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) expect(tokens(run([hello(seed)]))).toEqual(['hello'])
  })

  it('fires early: well before the movement ends', () => {
    const frames = hello(1)(0)
    const moveStart = 400
    const moveEnd = moveStart + 700
    const events = run([hello(1)])
    const fired = events.find(({ e }) => e.type === 'token')
    expect(fired).toBeDefined()
    expect(fired!.t).toBeLessThan(moveEnd - 150)
    expect(frames.length).toBeGreaterThan(0)
  })

  it('says HELLO once per sign, and again for the next one', () => {
    expect(tokens(run([hello(1), hello(2)]))).toEqual(['hello', 'hello'])
  })

  it('ignores the same flat-hand movement made low in the frame', () => {
    expect(tokens(run([hello(1, [0.5, 0.8])]))).not.toContain('hello')
  })

  it('also fires when the salute leaves the forehead mostly downward, as a real one often does', () => {
    const down = {
      durationMs: 700,
      hands: [{ handedness: 'Right' as const, shape: 'B' as const, roll: () => -10, path: (u: number): [number, number] => [-0.6 * u, 2.2 * u] }]
    }
    const part = (t0: number) => performSign(down, { random: rng(2), aspect: ASPECT, t0, center: [0.5, 0.2], restBeforeMs: 400, restAfterMs: 500 })
    expect(tokens(run([part], 'command', { cx: 0.5, cy: 0.38, w: 0.16, h: 0.3 }))).toEqual(['hello'])
  })

  it('ignores other signs', () => {
    for (const w of ['YES', 'NO', 'PLAY', 'TOMORROW']) {
      const part = (t0: number) => performSign(WORDS[w], { random: rng(3), aspect: ASPECT, t0, center: [0.5, 0.35] })
      expect(tokens(run([part]))).not.toContain('hello')
    }
  })

  it('stays silent with no hands and in Spell mode', () => {
    expect(tokens(run([(t0) => emptyFrames(t0, 2000)]))).toEqual([])
    expect(tokens(run([hello(1)], 'spell'))).toEqual([])
  })

  describe('with a face in view, the forehead is where the face is, not a fixed part of the frame', () => {
    // hello() puts the palm at about y 0.2 (wrist 0.35).
    it('fires for a salute at the forehead of a face in the middle of the frame', () => {
      expect(tokens(run([hello(1)], 'command', { cx: 0.5, cy: 0.38, w: 0.16, h: 0.3 }))).toEqual(['hello'])
    })

    it('fires for a low face where the frame-only rule would have refused', () => {
      // Palm at y 0.45 is below the frame fallback (0.38) but well above this low face.
      expect(tokens(run([hello(1, [0.5, 0.6])], 'command', { cx: 0.5, cy: 0.62, w: 0.16, h: 0.3 }))).toEqual(['hello'])
      expect(tokens(run([hello(1, [0.5, 0.6])]))).toEqual([])
    })

    it('refuses a sweep at the chest even though it is near the top of a small, high face frame', () => {
      // Face high in the frame: this palm (y 0.2) is at the chin/chest of a face at cy 0.05, h 0.1.
      expect(tokens(run([hello(1)], 'command', { cx: 0.5, cy: 0.02, w: 0.08, h: 0.1 }))).toEqual([])
    })
  })
})

describe('lexicon: two-handed MEETING (both hands come together)', () => {
  const meeting = (seed: number, spec = WORDS.MEETING) => (t0: number) =>
    performSign(spec, { random: rng(seed), aspect: ASPECT, t0, center: [0.5, 0.5], restBeforeMs: 400, restAfterMs: 500 })

  it('recognizes MEETING with nothing taught', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) expect(tokens(run([meeting(seed)]))).toEqual(['meeting'])
  })

  it('says MEETING once per sign', () => {
    expect(tokens(run([meeting(1), meeting(2)]))).toEqual(['meeting', 'meeting'])
  })

  it('ignores two open hands coming together, one-handed signs and an empty frame', () => {
    const clap = {
      durationMs: 700,
      hands: [
        { handedness: 'Right' as const, shape: 'FIVE' as const, offset: [-1.8, 0] as [number, number], path: (u: number): [number, number] => [1.4 * u, 0] },
        { handedness: 'Left' as const, shape: 'FIVE' as const, offset: [1.8, 0] as [number, number], path: (u: number): [number, number] => [-1.4 * u, 0] }
      ]
    }
    expect(tokens(run([meeting(1, clap)]))).not.toContain('meeting')
    for (const w of ['YES', 'NO', 'PLAY']) expect(tokens(run([meeting(1, WORDS[w])]))).not.toContain('meeting')
  })

  it('does not say MEETING for hands that stay apart', () => {
    const apart = { ...WORDS.MEETING, hands: WORDS.MEETING.hands.map((h) => ({ ...h, path: () => [0, 0] as [number, number] })) }
    expect(tokens(run([meeting(1, apart)]))).toEqual([])
  })
})
