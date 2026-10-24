import type { SignTemplate } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { SENSITIVITY, type FrameSample, type SensitivityProfile } from '../types'
import { RecognitionSession, type RecognitionEvent } from './session'
import { TeachSession } from './teach'
import {
  performHolds,
  performSign,
  rng,
  timeline,
  UNKNOWN,
  WORDS,
  type HoldStep,
  type PerformOptions,
  type ShapeName,
  type SignSpec
} from './synthetic'

const ASPECT = 4 / 3

type Part = (t0: number) => FrameSample[]
type Extra = Partial<PerformOptions>
const sign = (spec: SignSpec, seed: number, extra: Extra = {}): Part => (t0) =>
  performSign(spec, { random: rng(seed), aspect: ASPECT, t0, ...extra })
const hold = (steps: HoldStep[], seed: number, extra: Extra = {}): Part => (t0) =>
  performHolds(steps, { random: rng(seed), aspect: ASPECT, t0, ...extra })

function teach(label: string, kind: 'word' | 'letter', parts: Part[]): SignTemplate[] {
  const session = new TeachSession(label, kind, parts.length, { aspect: ASPECT })
  for (const f of timeline(parts)) session.update(f)
  return session.finish(0)
}

const seeds = (n: number, from: number): number[] => Array.from({ length: n }, (_, i) => from + i * 13)

const TEMPLATES = [
  ...teach('HELLO', 'word', seeds(5, 1).map((s) => sign(WORDS.HELLO, s))),
  ...teach('PLAY', 'word', seeds(5, 2).map((s) => sign(WORDS.PLAY, s))),
  ...teach('L', 'letter', seeds(5, 3).map((s) => hold([{ shape: 'L', holdMs: 900 }], s))),
  ...teach('A', 'letter', seeds(5, 4).map((s) => hold([{ shape: 'A', holdMs: 900 }], s)))
]

function session(templates = TEMPLATES): RecognitionSession {
  const s = new RecognitionSession({ aspect: ASPECT })
  s.setTemplates(templates)
  return s
}

function run(s: RecognitionSession, frames: FrameSample[]): RecognitionEvent[] {
  return frames.flatMap((f) => s.update(f))
}

/** Events with their time relative to the first frame. */
function timed(s: RecognitionSession, frames: FrameSample[]): { at: number; event: RecognitionEvent }[] {
  return frames.flatMap((f) => s.update(f).map((event) => ({ at: f.t - frames[0].t, event })))
}

const letter = (text: string): RecognitionEvent => ({ type: 'token', text, kind: 'letter' })

describe('RecognitionSession', () => {
  it('emits signStart, then the recognized word', () => {
    const events = run(session(), timeline([sign(WORDS.PLAY, 500), sign(WORDS.HELLO, 501)]))
    expect(events).toEqual([
      { type: 'signStart' },
      { type: 'token', text: 'PLAY', kind: 'word' },
      { type: 'signStart' },
      { type: 'token', text: 'HELLO', kind: 'word' }
    ])
  })

  it('rejects every movement when nothing has been taught', () => {
    const events = run(session([]), timeline([sign(WORDS.PLAY, 500), hold([{ shape: 'L', holdMs: 900 }], 501)]))
    expect(events).toEqual([{ type: 'signStart' }, { type: 'rejected' }])
  })

  it('follows every signStart with exactly one outcome', () => {
    const twitch: SignSpec = { durationMs: 120, hands: [{ handedness: 'Right', shape: 'B', path: (u) => [0.8 * u, 0] }] }
    const parts = [
      sign(WORDS.HELLO, 600),
      sign(UNKNOWN.zigzag, 601),
      sign(twitch, 602),
      sign(WORDS.YES, 603),
      sign(UNKNOWN.twoHandSwing, 604),
      sign(WORDS.PLAY, 605)
    ]
    const events = run(session(), timeline(parts)).filter((e) => e.type !== 'token' || e.kind === 'word')
    const starts = events.filter((e) => e.type === 'signStart')
    expect(starts).toHaveLength(parts.length)
    events.forEach((e, i) => expect(e.type === 'signStart').toBe(i % 2 === 0))
    expect(events.filter((_, i) => i % 2 === 1).map((e) => (e.type === 'token' ? e.text : e.type))).toEqual([
      'HELLO',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'PLAY'
    ])
  })

  it('emits letters from holds without signStart, and stays silent on unknown shapes', () => {
    const steps: HoldStep[] = (['L', 'FIVE', 'A'] as ShapeName[]).map((shape) => ({ shape, holdMs: 900 }))
    expect(run(session(), timeline([hold(steps, 700)]))).toEqual([letter('L'), letter('A')])
  })

  it("does not read a recognized word's last shape as a letter, but reads a hold after an unknown movement", () => {
    const withB = [...TEMPLATES, ...teach('B', 'letter', seeds(5, 5).map((s) => hold([{ shape: 'B', holdMs: 900 }], s)))]
    const after = { restAfterMs: 1500 }
    expect(run(session(withB), timeline([sign(WORDS.HELLO, 710, after)]))).toEqual([
      { type: 'signStart' },
      { type: 'token', text: 'HELLO', kind: 'word' }
    ])
    // The zigzag ends in an L hand.
    expect(run(session(withB), timeline([sign(UNKNOWN.zigzag, 711, after)]))).toEqual([
      { type: 'signStart' },
      { type: 'rejected' },
      letter('L')
    ])
  })

  it('reads letters held right after raising the hand into view', () => {
    const s = session()
    s.setMode('spell')
    const raised = { raiseMs: 350, lowerMs: 300 }
    const parts = [1, 2, 3].map((i) => hold([{ shape: 'L', holdMs: 1200 }], 720 + i, raised))
    expect(run(s, timeline(parts, 600))).toEqual([letter('L'), letter('L'), letter('L')])
  })

  it('outside Spell mode, holds a letter back while a control gesture could still fire', () => {
    const frames = timeline([hold([{ shape: 'L', holdMs: 3000 }], 730)])
    const held = timed(session(), frames)
    expect(held.map((e) => e.event)).toEqual([letter('L')])
    expect(held[0].at).toBeGreaterThan(1000) // a fist (0.9 s) would have fired by now

    // The gesture engine fires at ~0.9 s and the app suspends recognition: no letter at all.
    const s = session()
    const fire = frames.findIndex((f) => f.t - frames[0].t > 950)
    const before = run(s, frames.slice(0, fire))
    s.suspend(600)
    expect([...before, ...run(s, frames.slice(fire))]).toEqual([])
  })

  it('releases a held-back letter as soon as the hand moves on', () => {
    const frames = timeline([hold([{ shape: 'L', holdMs: 700 }, { shape: 'A', holdMs: 900 }], 740)])
    const events = timed(session(), frames)
    expect(events.map((e) => e.event)).toEqual([letter('L'), letter('A')])
    expect(events[0].at).toBeLessThan(1100) // at the change to A, not after the full wait
  })

  it('gives Spell-mode letters without the wait', () => {
    const s = session()
    s.setMode('spell')
    const [first] = timed(s, timeline([hold([{ shape: 'L', holdMs: 3000 }], 750)]))
    expect(first).toEqual({ at: expect.any(Number), event: letter('L') })
    expect(first.at).toBeLessThan(600)
  })

  it('is letters only in spell mode', () => {
    const s = session()
    s.setMode('spell')
    const events = run(s, timeline([sign(WORDS.HELLO, 800), hold([{ shape: 'L', holdMs: 900 }], 801)]))
    expect(events).toEqual([letter('L')])
    s.setMode('dictation')
    expect(run(s, timeline([sign(WORDS.HELLO, 802)]))).toEqual([
      { type: 'signStart' },
      { type: 'token', text: 'HELLO', kind: 'word' }
    ])
  })

  it('ignores the camera while suspended, and a shape still held after it', () => {
    const s = session()
    const frames = timeline([hold([{ shape: 'L', holdMs: 1500 }, { shape: 'A', holdMs: 900 }], 900)])
    run(s, frames.slice(0, 3))
    s.suspend(400)
    const events = run(s, frames.slice(3))
    expect(events).toEqual([letter('A')])
  })

  it('makes holds longer at low sensitivity', () => {
    const frames = timeline([hold([{ shape: 'L', holdMs: 1500 }], 1000)])
    const at = (profile: SensitivityProfile): number => {
      const s = session()
      s.setMode('spell')
      s.setSensitivity(profile)
      return timed(s, frames)[0].at
    }
    expect(at(SENSITIVITY.medium)).toBeLessThan(600)
    expect(at(SENSITIVITY.low)).toBeGreaterThanOrEqual(500 * SENSITIVITY.low.holdScale)
  })
})
