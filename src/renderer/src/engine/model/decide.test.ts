import { describe, expect, it } from 'vitest'
import {
  combine,
  decide,
  describeTop,
  GESTURE_OVERRIDE_P,
  moreConfident,
  taughtConfidence,
  wordProbabilities,
  withTaught,
  yieldToGesture,
  type WordScore
} from './decide'

const score = (word: string, p: number, rank = 0): WordScore => ({ word, p, rank })

describe('wordProbabilities: softmax over the enabled words only', () => {
  it('ignores every class outside the groups, and ranks each word among all classes', () => {
    // Class 3 (not enabled) is the model's top sign; among the enabled ones class 1 leads.
    const logits = [1, 3, 2, 10]
    const ranked = wordProbabilities(logits, [
      { word: 'a', classes: [0] },
      { word: 'b', classes: [1] },
      { word: 'c', classes: [2] }
    ])
    const z = Math.exp(1) + Math.exp(3) + Math.exp(2)
    expect(ranked.map((s) => s.word)).toEqual(['b', 'c', 'a'])
    expect(ranked[0].p).toBeCloseTo(Math.exp(3) / z)
    expect(ranked.reduce((sum, s) => sum + s.p, 0)).toBeCloseTo(1)
    expect(ranked.map((s) => s.rank)).toEqual([1, 2, 3])
  })

  it('sums the variants of one word (MAIL1, MAIL2) and takes their best rank', () => {
    const ranked = wordProbabilities([0, 2, 2, 5], [
      { word: 'mail', classes: [1, 2] },
      { word: 'send', classes: [3] }
    ])
    const z = 2 * Math.exp(2) + Math.exp(5)
    expect(ranked).toEqual([
      { word: 'send', p: expect.closeTo(Math.exp(5) / z, 6), rank: 0 },
      { word: 'mail', p: expect.closeTo((2 * Math.exp(2)) / z, 6), rank: 1 }
    ])
  })

  it('is empty with no groups', () => {
    expect(wordProbabilities([1, 2], [])).toEqual([])
  })
})

describe('decide: accept at p >= 0.7 within the rank limit, ask on a close call, else reject', () => {
  it('accepts a sure word the model also ranks first of all its signs', () => {
    expect(decide([score('hello', 0.7), score('bye', 0.2)], 1)).toEqual({ status: 'accepted', word: 'hello', p: 0.7 })
    expect(decide([score('hello', 0.69), score('bye', 0.2)], 1).status).toBe('rejected')
  })

  it('rejects a sure word the model ranks below another sign it knows (the open-set check)', () => {
    expect(decide([score('hello', 0.95, 1)], 1).status).toBe('rejected')
    expect(decide([score('help', 0.95, 2)], 3).status).toBe('accepted')
    expect(decide([score('help', 0.95, 3)], 3).status).toBe('rejected')
  })

  it('makes two likely words within the margin a "Did you mean"', () => {
    expect(decide([score('yes', 0.5), score('no', 0.4), score('why', 0.1)])).toEqual({ status: 'ambiguous', options: ['yes', 'no'] })
    expect(decide([score('yes', 0.6), score('no', 0.36)])).toEqual({ status: 'ambiguous', options: ['yes', 'no'] })
    expect(decide([score('yes', 0.62), score('no', 0.36)]).status).toBe('rejected')
    expect(decide([]).status).toBe('rejected')
  })
})

describe('moreConfident: the hand-slot assignment whose best word is more likely', () => {
  it('keeps the as-tracked answer unless the swapped one is surer', () => {
    const tracked = { ranked: [score('hello', 0.6)], swapped: false }
    const swapped = { ranked: [score('bye', 0.9)], swapped: true }
    expect(moreConfident(tracked, swapped)).toBe(swapped)
    expect(moreConfident(swapped, tracked)).toBe(swapped)
    expect(moreConfident(tracked, null)).toBe(tracked)
  })
})

describe('combine: the Kaggle model decides its words, ASL Citizen adds its own', () => {
  const islrWords = new Set(['hello', 'thank you', 'please'])

  it('takes a Kaggle accept and never asks ASL Citizen', () => {
    expect(combine([score('hello', 0.9)], [score('help', 0.99)], islrWords)).toEqual({ status: 'accepted', word: 'hello', p: 0.9, source: 'islr' })
  })

  it('takes ASL Citizen’s word the Kaggle model lacks, at p >= 0.7 within its top 3 of all signs', () => {
    expect(combine([score('please', 0.5)], [score('help', 0.8, 2)], islrWords)).toMatchObject({ status: 'accepted', word: 'help', source: 'citizen' })
    expect(combine([score('please', 0.5)], [score('help', 0.8, 3)], islrWords).status).toBe('rejected')
    expect(combine([score('please', 0.5)], [score('help', 0.65)], islrWords).status).toBe('rejected')
  })

  it('lets ASL Citizen confirm a shared word only when the Kaggle model ranked it first too', () => {
    expect(combine([score('please', 0.6)], [score('please', 0.9)], islrWords)).toMatchObject({ status: 'accepted', word: 'please', source: 'citizen' })
    expect(combine([score('hello', 0.6)], [score('please', 0.9)], islrWords).status).toBe('rejected')
  })

  it('falls back to the Kaggle close call, then rejects; without ASL Citizen it is the Kaggle model alone', () => {
    expect(combine([score('yes', 0.5), score('no', 0.45)], [score('help', 0.4)], new Set(['yes', 'no']))).toMatchObject({ status: 'ambiguous', options: ['yes', 'no'] })
    expect(combine([score('hello', 0.5)], null, islrWords).status).toBe('rejected')
    expect(combine([score('hello', 0.95, 1)], null, islrWords).status).toBe('rejected')
  })
})

describe('withTaught: the model first, the user’s taught signs second', () => {
  const hello = { status: 'accepted' as const, word: 'hello', p: 0.8 }

  it('agrees on the same word whatever the case of the taught label', () => {
    expect(withTaught(hello, { status: 'accepted', label: 'HELLO', distance: 0.2, radius: 1.5 })).toEqual({ status: 'accepted', word: 'hello', source: 'model' })
  })

  it('gives a conflict to the more confident: a tight taught match beats a less sure model word', () => {
    expect(taughtConfidence(0, 1.5)).toBe(1)
    expect(taughtConfidence(1.5, 1.5)).toBe(0.5)
    expect(withTaught(hello, { status: 'accepted', label: 'MUSIC', distance: 0.3, radius: 1.5 })).toEqual({ status: 'accepted', word: 'MUSIC', source: 'taught' })
    expect(withTaught(hello, { status: 'accepted', label: 'MUSIC', distance: 1.2, radius: 1.5 })).toEqual({ status: 'accepted', word: 'hello', source: 'model' })
  })

  it('takes whichever one is sure over the other’s close call or rejection', () => {
    expect(withTaught({ status: 'rejected' }, { status: 'accepted', label: 'SPOTIFY', distance: 1, radius: 2 })).toEqual({ status: 'accepted', word: 'SPOTIFY', source: 'taught' })
    expect(withTaught({ status: 'ambiguous', options: ['yes', 'no'] }, { status: 'accepted', label: 'SPOTIFY', distance: 1, radius: 2 })).toMatchObject({ word: 'SPOTIFY' })
    expect(withTaught(hello, { status: 'ambiguous', options: ['MUSIC', 'PLAY'] })).toMatchObject({ status: 'accepted', word: 'hello' })
  })

  it('merges two close calls, the model’s options first, and passes a rejection on', () => {
    expect(withTaught({ status: 'ambiguous', options: ['yes', 'no'] }, { status: 'ambiguous', options: ['MUSIC', 'YES'] })).toEqual({
      status: 'ambiguous',
      options: ['yes', 'no', 'music'],
      source: 'model'
    })
    expect(withTaught({ status: 'rejected' }, { status: 'ambiguous', options: ['MUSIC', 'PLAY'] })).toEqual({ status: 'ambiguous', options: ['MUSIC', 'PLAY'], source: 'taught' })
    expect(withTaught({ status: 'rejected' }, { status: 'rejected' })).toEqual({ status: 'rejected' })
  })
})

describe('yieldToGesture: a swipe or a held control shape keeps the movement unless the model is very sure', () => {
  it(`keeps only accepts at p >= ${GESTURE_OVERRIDE_P}`, () => {
    expect(yieldToGesture({ status: 'accepted', word: 'yes', p: 0.97 })).toEqual({ status: 'accepted', word: 'yes', p: 0.97 })
    expect(yieldToGesture({ status: 'accepted', word: 'yes', p: 0.85 })).toEqual({ status: 'rejected' })
    expect(yieldToGesture({ status: 'ambiguous', options: ['yes', 'no'] })).toEqual({ status: 'rejected' })
  })
})

describe('describeTop', () => {
  it('prints the top 3 with their probabilities for the dev log', () => {
    expect(describeTop([score('hello', 0.931), score('bye', 0.04), score('yes', 0.01), score('no', 0.001)])).toBe('hello 0.93 · bye 0.04 · yes 0.01')
  })
})
