import { describe, expect, it } from 'vitest'
import { performHolds, rng, type ShapeName } from './synthetic'
import { RecognitionSession, type RecognitionEvent } from './session'

const ASPECT = 16 / 9

function show(shape: ShapeName, seed: number, holdMs = 1200): { tokens: string[]; firstAt: number | null } {
  const s = new RecognitionSession({ aspect: ASPECT })
  s.setNumbers(true)
  const events: { e: RecognitionEvent; t: number }[] = []
  const frames = performHolds([{ shape, holdMs }], { random: rng(seed), aspect: ASPECT, dropout: 0.02, raiseMs: 400, lowerMs: 300 })
  for (const f of frames) for (const e of s.update(f)) events.push({ e, t: f.t })
  const toks = events.flatMap(({ e }) => (e.type === 'token' ? [e.text] : []))
  const first = events.find(({ e }) => e.type === 'token')
  return { tokens: toks, firstAt: first ? first.t : null }
}

describe('ASL numbers 1-5 from the handshape alone', () => {
  const cases: [ShapeName, string][] = [['ONE', '1'], ['V', '2'], ['W', '3'], ['FIVE', '5']]
  for (const [shape, digit] of cases) {
    it(`reads ${digit} once, quickly`, () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const r = show(shape, seed)
        expect(r.tokens).toEqual([digit])
        // Raised in over 400 ms, so the hand is in place at ~400 ms; the number follows within ~0.5 s.
        expect(r.firstAt!).toBeLessThan(1000)
      }
    })
  }

  it('reads nothing for a fist or a bare B/C shape', () => {
    for (const shape of ['S', 'A', 'C'] as ShapeName[]) expect(show(shape, 1).tokens).toEqual([])
  })

  it('stays off until enabled', () => {
    const s = new RecognitionSession({ aspect: ASPECT })
    const frames = performHolds([{ shape: 'FIVE', holdMs: 1200 }], { random: rng(1), aspect: ASPECT, raiseMs: 400 })
    expect(frames.flatMap((f) => s.update(f)).filter((e) => e.type === 'token')).toEqual([])
  })
})
