import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import type { FrameSample } from '../types'
import { faceBoxOf } from './faceBox'
import { RecognitionSession, type RecognitionEvent } from './session'
import { controlGestureClips, replayStream } from './streamEval'
import { STREAM_RULES } from './streamRules'
import type { StreamRule } from './streamRules/types'
import { FACE_HOLD_MS, STREAM_COOLDOWN_MS, STREAM_GAP_MS, StreamingSignMatcher } from './streaming'
import { makeHand } from '../gestures/synthetic'
import { syntheticFace } from './synthetic'

const hand = makeHand({ pose: 'openPalm' })
const frame = (t: number, withHand = true, face = false): FrameSample => ({
  t,
  hands: withHand ? [hand] : [],
  ...(face ? { face: syntheticFace({ cx: 0.5, cy: 0.3, w: 0.2, h: 0.3 }) } : {})
})
/** A rule that fires on the frames whose time `when` says. */
const ruleAt = (word: string, when: (t: number) => boolean, seen: number[] = []): StreamRule => ({
  word,
  hands: 1,
  fires: (history) => {
    seen.push(history.length)
    return when(history[history.length - 1].t)
  }
})

describe('faceBoxOf', () => {
  it('is the bounding box of the face mesh, as fractions of the image', () => {
    const box = faceBoxOf([
      { x: 0.4, y: 0.2, z: 0 },
      { x: 0.6, y: 0.5, z: 0 },
      { x: 0.5, y: 0.35, z: 0 }
    ])
    expect(box).toEqual({ cx: 0.5, cy: 0.35, w: expect.closeTo(0.2, 9), h: expect.closeTo(0.3, 9) })
  })

  it('is null with no face, or a degenerate one', () => {
    expect(faceBoxOf(undefined)).toBeNull()
    expect(faceBoxOf([])).toBeNull()
    expect(faceBoxOf([{ x: 0.5, y: 0.5, z: 0 }])).toBeNull()
  })
})

describe('StreamingSignMatcher: the dictionary signs, then the stream rules, every frame', () => {
  it('fires a rule the moment it says so, with the face box in the context', () => {
    let ctxFace: unknown = null
    const rule: StreamRule = {
      word: 'thank you',
      hands: 1,
      fires: (history, ctx) => {
        ctxFace = ctx.face
        return history.length === 3
      }
    }
    const m = new StreamingSignMatcher({ rules: [rule] })
    expect([0, 33, 66].map((t) => m.update(frame(t, true, true), 4 / 3))).toEqual([null, null, 'thank you'])
    expect(ctxFace).toMatchObject({ cx: 0.5, cy: 0.3 })
  })

  it('holds the face box across frames without one, for a while', () => {
    const m = new StreamingSignMatcher()
    m.update(frame(0, true, true), 1)
    m.update(frame(FACE_HOLD_MS - 10, true), 1)
    expect(m.faceBox).toBeDefined()
    m.update(frame(FACE_HOLD_MS + 50, true), 1)
    expect(m.faceBox).toBeUndefined()
  })

  it('starts the history over after a word, so the same frames never make a second word', () => {
    // A watcher rule that never fires but notes the oldest frame of each history it is shown.
    const oldest: number[] = []
    const watcher: StreamRule = { word: 'time', hands: 1, fires: (h) => (oldest.push(h[0].t), false) }
    const m = new StreamingSignMatcher({ rules: [ruleAt('what', (t) => t === 99), watcher] })
    const fired: (string | null)[] = []
    for (let t = 0; t <= 990; t += 33) fired.push(m.update(frame(t), 1))
    expect(fired.filter(Boolean)).toEqual(['what'])
    // Before the word every history starts at the first frame; after it, after the word's frame.
    expect(oldest.slice(0, 3)).toEqual([0, 0, 0])
    expect(oldest.slice(3).length).toBeGreaterThan(0)
    expect(oldest.slice(3).every((t) => t > 99)).toBe(true)
  })

  it('a phrase streams word by word: another word only STREAM_GAP_MS later, the same word only after its cooldown', () => {
    const m = new StreamingSignMatcher({
      rules: [ruleAt('tomorrow', (t) => t >= 0), ruleAt('meeting', (t) => t >= 0)]
    })
    const out: [number, string][] = []
    for (let t = 0; t <= STREAM_COOLDOWN_MS + 200; t += 50) {
      const w = m.update(frame(t), 1)
      if (w) out.push([t, w])
    }
    expect(out[0]).toEqual([0, 'tomorrow'])
    expect(out[1]).toEqual([STREAM_GAP_MS, 'meeting'])
    expect(out[2][1]).toBe('tomorrow')
    expect(out[2][0]).toBeGreaterThanOrEqual(STREAM_COOLDOWN_MS)
  })

  it('never fires with no hands in view, or while a control gesture is held (mayFire false)', () => {
    const fires = vi.fn(() => true)
    const m = new StreamingSignMatcher({ rules: [{ word: 'dad', hands: 1, fires }] })
    expect(m.update(frame(0, false), 1)).toBeNull()
    expect(m.update(frame(33), 1, false)).toBeNull()
    expect(m.update(frame(66), 1)).toBe('dad')
  })

  it('skips a rule that throws, once warned, and carries on with the next', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken: StreamRule = { word: 'open', hands: 2, fires: () => { throw new Error('bug') } }
    const m = new StreamingSignMatcher({ rules: [broken, ruleAt('time', () => true)] })
    expect(m.update(frame(0), 1)).toBe('time')
    expect(m.update(frame(STREAM_COOLDOWN_MS + 100), 1)).toBe('time')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('RecognitionSession: streaming signs first, settle after them', () => {
  /** A rule firing on the given frame times. */
  const at = (word: string, times: number[]): StreamRule => ({ word, hands: 1, fires: (h) => times.includes(h[h.length - 1].t) })

  it('streams each word of a phrase in a row while the hands stay up, with no movement outcome for any of it', () => {
    // Frame times are multiples of 33 ms: the four words about 0.4-0.5 s apart.
    const session = new RecognitionSession({ aspect: 4 / 3, streamRules: [at('tomorrow', [396]), at('meeting', [891]), at('what', [1386]), at('time', [1782])] })
    session.setMode('command')
    const events: { t: number; e: RecognitionEvent }[] = []
    // A hand sweeping back and forth for 2.4 s: one long movement the segmenter would cut.
    for (let t = 0; t <= 2400; t += 33) {
      const x = 0.5 + 0.25 * Math.sin(t / 150)
      for (const e of session.update({ t, hands: [makeHand({ pose: 'openPalm', x, y: 0.6 })] })) events.push({ t, e })
    }
    for (let t = 2433; t <= 3500; t += 33) for (const e of session.update({ t, hands: [] })) events.push({ t, e })
    const tokens = events.filter(({ e }) => e.type === 'token').map(({ e }) => (e.type === 'token' ? e.text : ''))
    expect(tokens).toEqual(['tomorrow', 'meeting', 'what', 'time'])
    // The movement they were signed in ends with no outcome: no model word, no guess.
    expect(events.filter(({ e }) => e.type === 'rejected' || (e.type === 'token' && !e.streamed))).toEqual([])
  })

  it('a gate (a control gesture held) keeps streaming signs from firing', () => {
    const session = new RecognitionSession({ aspect: 4 / 3, streamRules: [at('dad', [100, 133])] })
    session.setMode('command')
    let holding = true
    session.setStreamGate(() => !holding)
    expect(session.update({ t: 100, hands: [hand] })).toEqual([])
    holding = false
    expect(session.update({ t: 133, hands: [hand] })).toEqual([{ type: 'token', text: 'dad', kind: 'word', streamed: true }])
  })

  it('Spell mode is letters only: no streaming signs', () => {
    const session = new RecognitionSession({ aspect: 4 / 3, streamRules: [at('time', [100])] })
    session.setMode('spell')
    expect(session.update({ t: 100, hands: [hand] })).toEqual([])
  })
})

describe('control gestures are never streaming signs', () => {
  /** Known clashes in the merged rules, to fix in their files (none now: DAD's open-palm clash is fixed by a palm-facing cap). */
  const KNOWN = new Set<string>([])

  it('no dictionary sign fires on any of them', () => {
    const fired = controlGestureClips().flatMap((clip) => replayStream(clip, { dictionary: DEFAULT_DICTIONARY }).map((h) => `${clip.name}: ${h.word}`))
    expect(fired).toEqual([])
  })

  it('no stream rule fires on any of them, apart from the known clashes', () => {
    const fired = controlGestureClips().flatMap((clip) =>
      replayStream(clip, { rules: STREAM_RULES })
        .filter((h) => !KNOWN.has(h.word))
        .map((h) => `${clip.name}: ${h.word}`)
    )
    expect(fired).toEqual([])
  })
})
