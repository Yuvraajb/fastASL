import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import type { SignTemplate } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { activeGestures } from '../../app/controller'
import { GestureEngine, HOLD_MS } from '../gestures/engine'
import { SENSITIVITY, type FrameSample } from '../types'
import { RecognitionSession } from './session'
import { STREAM_RULES } from './streamRules'
import { TeachSession } from './teach'
import { performHolds, rng, timeline, type ShapeName } from './synthetic'

/*
 * The demo spells a person's name with two letters, K and C, and nothing else taught: "meeting kc".
 * These run the app's own recognition setup (the dictionary and stream rules, Command mode) on
 * synthetic hands, so they prove the wiring and the false-positive guard, not your real hand.
 */

const ASPECT = 4 / 3
type Part = (t0: number) => FrameSample[]
const hold = (shape: ShapeName, holdMs: number, seed: number): Part => (t0) =>
  performHolds([{ shape, holdMs }], { random: rng(seed), aspect: ASPECT, t0 })

function teach(label: ShapeName): SignTemplate[] {
  const session = new TeachSession(label, 'letter', 5, { aspect: ASPECT })
  for (const frame of timeline([0, 1, 2, 3, 4].map((i) => hold(label, 900, 3 + i * 13)))) session.update(frame)
  return session.finish(0)
}

const TAUGHT = [...teach('K'), ...teach('C')]

function session(): RecognitionSession {
  const rec = new RecognitionSession({
    controlHoldMs: Math.max(...Object.values(HOLD_MS)),
    dictionary: DEFAULT_DICTIONARY,
    streamRules: STREAM_RULES
  })
  rec.setTemplates(TAUGHT)
  rec.setSensitivity(SENSITIVITY.medium)
  rec.setAspect(ASPECT)
  rec.setMode('command')
  return rec
}

/** What recognition reports for the frames: tokens as "text:kind". */
function tokens(parts: Part[]): string[] {
  const rec = session()
  return timeline(parts)
    .flatMap((f) => rec.update(f))
    .flatMap((e) => (e.type === 'token' ? [`${e.text}:${e.kind}`] : []))
}

describe('fingerspelling K and C with only those two letters taught', () => {
  it('teaches five repetitions of each', () => {
    expect(TAUGHT.filter((t) => t.label === 'K')).toHaveLength(5)
    expect(TAUGHT.filter((t) => t.label === 'C')).toHaveLength(5)
  })

  it('a held K is the letter K, and a held C the letter C', () => {
    expect(tokens([hold('K', 2200, 41)])).toEqual(['K:letter'])
    expect(tokens([hold('C', 2200, 42)])).toEqual(['C:letter'])
  })

  it('a small, noisy hand far from the camera still reads K and C', () => {
    const far = (shape: ShapeName, seed: number): Part => (t0) =>
      performHolds([{ shape, holdMs: 2200 }], { random: rng(seed), aspect: ASPECT, t0, handSize: 0.1, noise: 0.004 })
    expect(tokens([far('K', 91), far('C', 92)])).toEqual(['K:letter', 'C:letter'])
  })

  it('K then C is read in order, however they are held', () => {
    for (const seed of [51, 52, 53, 54]) {
      expect(tokens([hold('K', 2200, seed), hold('C', 2200, seed + 100)]), `seed ${seed}`).toEqual(['K:letter', 'C:letter'])
    }
  })

  it('neither letter fires a control gesture in a view that takes signs', () => {
    const views = [
      activeGestures({ kind: 'ready' }, 'command'),
      activeGestures({ kind: 'building', tokens: [], current: null, sentence: '' }, 'command'),
      activeGestures({ kind: 'conversation', phase: 'reply', said: '', steps: [] }, 'command')
    ]
    for (const active of views) {
      for (const shape of ['K', 'C'] as const) {
        const engine = new GestureEngine({ aspect: ASPECT })
        engine.setActive(active)
        const fired = timeline([hold(shape, 2500, 61)]).flatMap((f) => engine.update(f))
        expect(fired, `${shape} in ${[...active].join(',')}`).toEqual([])
      }
    }
  })

  it('other held hand shapes are not read as K or C', () => {
    const others: ShapeName[] = ['B', 'FIVE', 'A', 'S', 'E', 'O', 'ONE', 'L', 'I', 'Y', 'W', 'CLAW']
    for (const shape of others) {
      const read = tokens([hold(shape, 2200, 71)]).filter((t) => t === 'K:letter' || t === 'C:letter')
      expect(read, shape).toEqual([])
    }
  })
})
