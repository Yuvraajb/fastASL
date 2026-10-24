import type { SignTemplate } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { dominantSlot, FRAME_FEATURE_DIM, HAND_FEATURE_DIM, keepActiveHand, selectSlots, slotEnergy, usedSlots } from './features'
import { Recognizer } from './recognizer'

/*
 * Which hands a word uses: a one-handed word learned or signed with the other hand resting in
 * view must still match, while a second hand that moves like a signing hand still counts.
 */

interface HandSpec {
  slot: number
  /** Shape offset: points sit at shape * (1..5) / 10. */
  shape: number
  /** Velocity in hand lengths per second. */
  v: [number, number]
}

/** One frame vector with the given hands (presence, points, handedness, weighted velocity). */
function frame(hands: HandSpec[]): number[] {
  const f = new Array<number>(FRAME_FEATURE_DIM).fill(0)
  for (const h of hands) {
    const base = h.slot * HAND_FEATURE_DIM
    f[base] = 1
    for (let i = 1; i <= 63; i++) f[base + i] = (h.shape * ((i % 5) + 1)) / 10
    f[base + 64] = h.slot === 0 ? 1 : -1
    f[base + 65] = h.v[0] * 0.3
    f[base + 66] = h.v[1] * 0.3
  }
  return f
}

/** A one-handed wave in slot 0: the shape drifts and the hand sweeps sideways and back. */
const wave = (other?: (i: number) => HandSpec | null): number[][] =>
  Array.from({ length: 20 }, (_, i) => {
    const signing: HandSpec = { slot: 0, shape: 1 + i / 19, v: [i < 10 ? 4 : -4, 1] }
    const extra = other?.(i)
    return frame(extra ? [signing, extra] : [signing])
  })

let n = 0
const word = (label: string, frames: number[][]): SignTemplate => ({ id: `w${n++}`, label, kind: 'word', frames, createdAt: 0 })

describe('hand slots', () => {
  it('usedSlots: the hands seen in at least half the frames; both when neither is', () => {
    const frames = wave((i) => (i < 5 ? { slot: 1, shape: 2, v: [0, 0] } : null))
    expect(usedSlots(frames)).toEqual([0])
    expect(usedSlots(wave(() => ({ slot: 1, shape: 2, v: [0, 0] })))).toEqual([0, 1])
    expect(usedSlots([new Array<number>(FRAME_FEATURE_DIM).fill(0)])).toEqual([0, 1])
  })

  it('selectSlots keeps exactly those hands, in order', () => {
    const f = frame([
      { slot: 0, shape: 1, v: [1, 0] },
      { slot: 1, shape: 3, v: [0, 2] }
    ])
    expect(selectSlots([f], [1])[0]).toEqual(f.slice(HAND_FEATURE_DIM))
    expect(selectSlots([f], [0, 1])[0]).toEqual(f)
  })

  it('keepActiveHand empties the hand that moved less, whichever slot it is in', () => {
    const resting = wave(() => ({ slot: 1, shape: 2, v: [0.2, 0] }))
    const kept = keepActiveHand(resting)
    expect(slotEnergy(kept)[1]).toBe(0)
    expect(kept.every((f) => f.slice(HAND_FEATURE_DIM).every((v) => v === 0))).toBe(true)
    expect(kept.map((f) => f.slice(0, HAND_FEATURE_DIM))).toEqual(resting.map((f) => f.slice(0, HAND_FEATURE_DIM)))

    const mirrored = resting.map((f) => [...f.slice(HAND_FEATURE_DIM), ...f.slice(0, HAND_FEATURE_DIM)])
    const keptLeft = keepActiveHand(mirrored)
    expect(keptLeft.every((f) => f.slice(0, HAND_FEATURE_DIM).every((v) => v === 0))).toBe(true)
  })

  it('keepActiveHand keeps the dominant hand when it is in view, even if the other hand moved more', () => {
    // The signing hand (slot 0) moves less than the other hand being lowered (slot 1).
    const lowering = wave(() => ({ slot: 1, shape: 2, v: [0, 9] }))
    expect(slotEnergy(lowering)[1]).toBeGreaterThan(slotEnergy(lowering)[0])
    const kept = keepActiveHand(lowering, 0)
    expect(kept.every((f) => f.slice(HAND_FEATURE_DIM).every((v) => v === 0))).toBe(true)
    expect(keepActiveHand(lowering, null).every((f) => f.slice(0, HAND_FEATURE_DIM).every((v) => v === 0))).toBe(true)
  })

  it('dominantSlot: the slot most one-handed word templates use', () => {
    const tpl = (frames: number[][]) => ({ kind: 'word', frames })
    expect(dominantSlot([])).toBeNull()
    expect(dominantSlot([tpl(wave()), tpl(wave()), tpl(wave(() => ({ slot: 1, shape: 2, v: [0, 0] })))])).toBe(0)
    const left = wave().map((f) => [...f.slice(HAND_FEATURE_DIM), ...f.slice(0, HAND_FEATURE_DIM)])
    expect(dominantSlot([tpl(left)])).toBe(1)
  })
})

describe('Recognizer: which hands are compared', () => {
  const r = new Recognizer()
  r.setTemplates([word('WAVE', wave()), word('WAVE', wave()), word('WAVE', wave())])

  it('a one-handed word matches with the other hand resting in view', () => {
    const c = r.classifyDynamic(wave(() => ({ slot: 1, shape: 2, v: [0.1, 0] })))
    expect(c).toMatchObject({ status: 'accepted', label: 'WAVE' })
    expect(c.distance).toBeLessThan(0.01)
  })

  it('but not when the other hand moves like a signing hand: that is another movement', () => {
    const c = r.classifyDynamic(wave((i) => ({ slot: 1, shape: 2, v: [i < 10 ? -4 : 4, 1] })))
    expect(c.status).toBe('rejected')
  })

  it('a word with a single template (one confirmed guess) gets the single-template radius', () => {
    const one = new Recognizer()
    one.setTemplates([word('WAVE', wave())])
    expect(one.wordRadius('WAVE')).toBe(2.0)
  })
})
