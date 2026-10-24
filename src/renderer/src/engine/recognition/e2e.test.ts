import type { SignTemplate } from '@shared/types'
import { describe, expect, it } from 'vitest'
import type { FrameSample } from '../types'
import { createTemplatePack, validateTemplatePack } from '@shared/templatePack'
import { RecognitionSession, type RecognitionEvent } from './session'
import { TeachSession } from './teach'
import { performHolds, performSign, rng, timeline, UNKNOWN, WORDS, type HoldStep, type SignSpec } from './synthetic'

/*
 * End to end on synthetic hands: teach signs with TeachSession exactly as the Settings flow
 * would (repetitions separated by hands-down gaps), round-trip them through a template pack,
 * then recognize fresh noisy repetitions with RecognitionSession.
 */

const ASPECT = 16 / 9
type Part = (t0: number) => FrameSample[]

const sign = (spec: SignSpec, seed: number): Part => (t0) => performSign(spec, { random: rng(seed), aspect: ASPECT, t0 })
const spell = (steps: HoldStep[], seed: number): Part => (t0) =>
  performHolds(steps, { random: rng(seed), aspect: ASPECT, t0, dropout: 0.02 })

/** Keeps signing until the session is complete, like a user watching the progress dots. */
function teach(label: string, kind: 'word' | 'letter', parts: Part[]): SignTemplate[] {
  const session = new TeachSession(label, kind, undefined, { aspect: ASPECT })
  for (const frame of timeline(parts)) if (!session.complete) session.update(frame)
  expect(session.complete).toBe(true)
  return session.finish()
}

const reps = (spec: SignSpec, n: number, seed: number): Part[] => Array.from({ length: n }, (_, i) => sign(spec, seed + i * 101))

function recognize(templates: SignTemplate[], parts: Part[], mode: 'command' | 'spell' = 'command'): RecognitionEvent[] {
  const session = new RecognitionSession({ aspect: ASPECT })
  session.setTemplates(templates)
  session.setMode(mode)
  return timeline(parts, 400).flatMap((f) => session.update(f))
}

/** Outcomes of movements (the events right after each signStart). */
const outcomes = (events: RecognitionEvent[]): string[] =>
  events.flatMap((e, i) => {
    if (i === 0 || events[i - 1].type !== 'signStart') return []
    if (e.type === 'token') return [e.text]
    if (e.type === 'ambiguous') return [`?${e.options.join('|')}`]
    return [e.type]
  })

/** SONG: MUSIC's movement with a 2% wider swing (taught from the same performances below). */
const SONG: SignSpec = {
  ...WORDS.MUSIC,
  hands: [{ ...WORDS.MUSIC.hands[0], path: (u) => WORDS.MUSIC.hands[0].path(u).map((v) => v * 1.02) as [number, number] }]
}

describe('teach, then recognize (synthetic signer)', () => {
  const taught = [
    ...teach('HELLO', 'word', reps(WORDS.HELLO, 14, 1)),
    ...teach('YES', 'word', reps(WORDS.YES, 14, 2)),
    ...teach('PLAY', 'word', reps(WORDS.PLAY, 14, 3))
  ]
  // Templates survive an export/import round trip unchanged.
  const pack = validateTemplatePack(JSON.parse(JSON.stringify(createTemplatePack(taught))))
  if (pack instanceof Error) throw pack
  const templates = pack.templates

  it('records ten templates per word', () => {
    expect(templates).toHaveLength(30)
    expect(new Set(templates.map((t) => t.id)).size).toBe(30)
  })

  it('recognizes new noisy repetitions of each word', () => {
    const order = [WORDS.PLAY, WORDS.HELLO, WORDS.YES, WORDS.YES, WORDS.HELLO, WORDS.PLAY, WORDS.HELLO]
    const labels = ['PLAY', 'HELLO', 'YES', 'YES', 'HELLO', 'PLAY', 'HELLO']
    expect(outcomes(recognize(templates, order.map((spec, i) => sign(spec, 10_000 + i))))).toEqual(labels)
  })

  it('rejects movements it was never taught', () => {
    const unknown = [UNKNOWN.zigzag, UNKNOWN.reverseCircle, UNKNOWN.reach, WORDS.MEETING, WORDS.TOMORROW]
    expect(outcomes(recognize(templates, unknown.map((spec, i) => sign(spec, 20_000 + i))))).toEqual(
      unknown.map(() => 'rejected')
    )
  })

  it('asks "did you mean" between two near-identical signs, and still knows the others', () => {
    const withPair = [...templates, ...teach('MUSIC', 'word', reps(WORDS.MUSIC, 14, 4)), ...teach('SONG', 'word', reps(SONG, 14, 4))]
    const results = outcomes(recognize(withPair, [sign(WORDS.MUSIC, 30_000), sign(SONG, 30_001), sign(WORDS.HELLO, 30_002)]))
    expect(results.slice(0, 2).every((r) => r.startsWith('?'))).toBe(true)
    for (const r of results.slice(0, 2)) expect(r.slice(1).split('|').slice(0, 2).sort()).toEqual(['MUSIC', 'SONG'])
    expect(results[2]).toBe('HELLO')
  })

  it('fingerspells taught letters in spell mode, including a double letter', () => {
    const letters = ['B', 'A', 'L'] as const
    const alphabet = letters.flatMap((shape, n) =>
      teach(shape, 'letter', Array.from({ length: 8 }, (_, i) => spell([{ shape, holdMs: 900 }], 40_000 + n * 10 + i)))
    )
    // B-A-L-L: the second L is a slide to the side.
    const word: HoldStep[] = [
      { shape: 'B', holdMs: 800 },
      { shape: 'A', holdMs: 800 },
      { shape: 'L', holdMs: 800 },
      { shape: 'L', holdMs: 800, at: [0.9, 0] }
    ]
    // PLAY moves a Y hand: no word in spell mode, and Y is not a taught letter.
    const events = recognize([...templates, ...alphabet], [spell(word, 50_000), sign(WORDS.PLAY, 50_001)], 'spell')
    expect(events).toEqual(['B', 'A', 'L', 'L'].map((text) => ({ type: 'token', text, kind: 'letter' })))
  })
})
