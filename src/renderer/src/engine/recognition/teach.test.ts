import { describe, expect, it } from 'vitest'
import type { FrameSample } from '../types'
import { euclidean } from './dtw'
import { FRAME_FEATURE_DIM, STATIC_FEATURE_DIM, staticFeatures } from './features'
import { RecognitionSession } from './session'
import { TEACH_REASONS, TeachSession, type TeachEvent, type TeachProgress } from './teach'
import {
  performHolds,
  performSign,
  poseLandmarks,
  rng,
  SHAPES,
  timeline,
  WORDS,
  type HandPose,
  type PerformOptions,
  type ShapeName,
  type SignSpec
} from './synthetic'

const ASPECT = 4 / 3

type Part = (t0: number) => FrameSample[]
type Extra = Partial<PerformOptions>

const reps = (spec: SignSpec, seeds: number[], extra: Extra = {}): Part[] =>
  seeds.map((seed) => (t0) => performSign(spec, { random: rng(seed), aspect: ASPECT, t0, ...extra }))

const holds = (shape: ShapeName, seeds: number[], extra: Extra = {}): Part[] =>
  seeds.map((seed) => (t0) => performHolds([{ shape, holdMs: 900 }], { random: rng(seed), aspect: ASPECT, t0, ...extra }))

const UPRIGHT: Omit<HandPose, 'shape'> = { handedness: 'Right', x: 0.5, y: 0.5, size: 0.17, roll: 0, pitch: 0, yaw: 0 }

/** Raise the hands into view, pause, sign, pause, lower them: one repetition. */
const RAISE_AND_LOWER: Extra = { raiseMs: 350, restBeforeMs: 500, restAfterMs: 500, lowerMs: 300 }

function feed(session: TeachSession, frames: FrameSample[]): TeachEvent[] {
  return frames.flatMap((f) => session.update(f))
}

const progressOf = (events: TeachEvent[]): TeachProgress[] =>
  events.flatMap((e) => (e.type === 'progress' ? [e.progress] : []))

const range = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i * 7)

describe('TeachSession (word)', () => {
  it('records ten repetitions, announcing each one as it starts', () => {
    const session = new TeachSession('HELLO', 'word', undefined, { aspect: ASPECT })
    expect(session.total).toBe(10)
    expect(session.progress).toEqual({ done: 0, total: 10, lastAccepted: null })
    const events = feed(session, timeline(reps(WORDS.HELLO, range(10))))
    expect(events.filter((e) => e.type === 'listening')).toHaveLength(10)
    expect(progressOf(events).map((p) => p.done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(session.complete).toBe(true)
  })

  it('stops listening once complete', () => {
    const session = new TeachSession('YES', 'word', 2, { aspect: ASPECT })
    const events = feed(session, timeline(reps(WORDS.YES, range(4))))
    expect(progressOf(events)).toHaveLength(2)
    expect(session.progress.done).toBe(2)
  })

  it('rejects a repetition that is too short, with a reason', () => {
    const twitch: SignSpec = { durationMs: 120, hands: [{ handedness: 'Right', shape: 'B', path: (u) => [0.8 * u, 0] }] }
    const session = new TeachSession('HELLO', 'word', undefined, { aspect: ASPECT })
    const [last] = progressOf(feed(session, timeline(reps(twitch, [1])))).slice(-1)
    expect(last).toEqual({ done: 0, total: 10, lastAccepted: false, reason: TEACH_REASONS.tooShort })
  })

  it('rejects an outlier that does not match the repetitions so far', () => {
    const session = new TeachSession('HELLO', 'word', undefined, { aspect: ASPECT })
    const parts = [...reps(WORDS.HELLO, range(3)), ...reps(WORDS.PLAY, [99]), ...reps(WORDS.HELLO, [100])]
    const progress = progressOf(feed(session, timeline(parts)))
    expect(progress.slice(-2)).toEqual([
      { done: 3, total: 10, lastAccepted: false, reason: TEACH_REASONS.outlier },
      { done: 4, total: 10, lastAccepted: true }
    ])
  })

  it('outvotes a bad first repetition as soon as two others agree', () => {
    const session = new TeachSession('HELLO', 'word', undefined, { aspect: ASPECT })
    const progress = progressOf(feed(session, timeline([...reps(WORDS.YES, [1]), ...reps(WORDS.HELLO, [2, 3])])))
    expect(progress.map((p) => [p.done, p.lastAccepted])).toEqual([
      [1, true],
      [1, true], // a 1-1 tie goes to the newest attempt
      [2, true]
    ])
    const live = new RecognitionSession({ aspect: ASPECT })
    live.setTemplates(session.finish(0))
    expect(timeline(reps(WORDS.HELLO, [4])).flatMap((f) => live.update(f))).toEqual([
      { type: 'signStart' },
      { type: 'token', text: 'HELLO', kind: 'word' }
    ])
  })

  it('learns the sign, not the hands rising and falling, when the user pauses around it', () => {
    const session = new TeachSession('HELLO', 'word', undefined, { aspect: ASPECT })
    const events = feed(session, timeline(reps(WORDS.HELLO, range(10), RAISE_AND_LOWER), 600))
    expect(session.complete).toBe(true)
    expect(progressOf(events).every((p) => p.reason === undefined)).toBe(true)

    const live = new RecognitionSession({ aspect: ASPECT })
    live.setTemplates(session.finish(0))
    const signed = timeline(reps(WORDS.HELLO, [500, 501], RAISE_AND_LOWER), 600).flatMap((f) => live.update(f))
    expect(signed.filter((e) => e.type !== 'signStart')).toEqual([
      { type: 'rejected' }, // raising the hands
      { type: 'token', text: 'HELLO', kind: 'word' },
      { type: 'rejected' }, // lowering them
      { type: 'rejected' },
      { type: 'token', text: 'HELLO', kind: 'word' },
      { type: 'rejected' }
    ])
  })

  it('finishes into one template per repetition', () => {
    const session = new TeachSession('HELLO', 'word', 3, { aspect: ASPECT })
    feed(session, timeline(reps(WORDS.HELLO, range(3))))
    const templates = session.finish(1234)
    expect(templates.map((t) => t.id)).toEqual(['HELLO-1234-0', 'HELLO-1234-1', 'HELLO-1234-2'])
    for (const t of templates) {
      expect(t).toMatchObject({ label: 'HELLO', kind: 'word', createdAt: 1234 })
      expect(t.frames).toHaveLength(32)
      expect(t.frames.every((f) => f.length === FRAME_FEATURE_DIM)).toBe(true)
      expect(t.frames.flat().every((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6)).toBe(true)
    }
  })
})

describe('TeachSession (letter)', () => {
  it('records five static holds and ignores movement', () => {
    const session = new TeachSession('L', 'letter', undefined, { aspect: ASPECT })
    expect(session.total).toBe(5)
    const events = feed(session, timeline(holds('L', range(5))))
    expect(events.some((e) => e.type === 'listening')).toBe(false)
    expect(progressOf(events).map((p) => p.done)).toEqual([1, 2, 3, 4, 5])
    const templates = session.finish(1)
    expect(templates).toHaveLength(5)
    expect(templates.every((t) => t.kind === 'letter' && t.frames.length === 1 && t.frames[0].length === STATIC_FEATURE_DIM)).toBe(true)
  })

  it('records holds made by raising the hand into view each time', () => {
    const session = new TeachSession('L', 'letter', undefined, { aspect: ASPECT })
    feed(session, timeline(holds('L', range(5), { raiseMs: 350, lowerMs: 300 }), 600))
    expect(session.complete).toBe(true)
  })

  it('outvotes a stray hold, such as the end of a word signed first', () => {
    const session = new TeachSession('L', 'letter', undefined, { aspect: ASPECT })
    const events = feed(session, timeline([...reps(WORDS.HELLO, [1]), ...holds('L', range(5))]))
    expect(progressOf(events).map((p) => [p.done, p.lastAccepted])).toEqual([
      [1, true], // HELLO's final B hold
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, true]
    ])
    const shape = (name: 'B' | 'L'): number[] =>
      staticFeatures({ handedness: 'Right', score: 1, landmarks: poseLandmarks({ ...UPRIGHT, shape: SHAPES[name] }, ASPECT) }, ASPECT)!
    const [b, l] = [shape('B'), shape('L')]
    for (const t of session.finish(1)) expect(euclidean(t.frames[0], l)).toBeLessThan(euclidean(t.frames[0], b))
  })

  it('rejects a different handshape as an outlier', () => {
    const session = new TeachSession('L', 'letter', undefined, { aspect: ASPECT })
    feed(session, timeline(holds('L', range(2))))
    const [last] = progressOf(feed(session, timeline(holds('S', [50])))).slice(-1)
    expect(last).toMatchObject({ done: 2, lastAccepted: false, reason: TEACH_REASONS.outlier })
  })
})
