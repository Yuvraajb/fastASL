import type { SignTemplate } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { SENSITIVITY } from '../types'
import { FRAME_FEATURE_DIM, STATIC_FEATURE_DIM } from './features'
import { Recognizer } from './recognizer'

/** A word whose frames move along one feature axis: easy to reason about distances. */
function ramp(axis: number, offset = 0, length = 12): number[][] {
  return Array.from({ length }, (_, i) => {
    const f = new Array<number>(FRAME_FEATURE_DIM).fill(0)
    f[axis] = (3 * i) / (length - 1)
    f[100] = offset
    return f
  })
}

/** A static vector at `value` on one axis. */
function point(axis: number, value: number): number[] {
  const v = new Array<number>(STATIC_FEATURE_DIM).fill(0)
  v[axis] = value
  return v
}

let n = 0
const word = (label: string, frames: number[][]): SignTemplate => ({ id: `w${n++}`, label, kind: 'word', frames, createdAt: 0 })
const letter = (label: string, ...frames: number[][]): SignTemplate => ({ id: `l${n++}`, label, kind: 'letter', frames, createdAt: 0 })

function recognizer(templates: SignTemplate[]): Recognizer {
  const r = new Recognizer({ wordThreshold: 1, letterThreshold: 1 })
  r.setTemplates(templates)
  return r
}

describe('Recognizer with no templates', () => {
  it('rejects everything', () => {
    const r = new Recognizer()
    expect(r.classifyDynamic(ramp(0))).toEqual({ status: 'rejected', distance: Infinity, alternatives: [] })
    expect(r.classifyStatic(point(0, 1)).status).toBe('rejected')
  })
})

describe('Recognizer.classifyDynamic', () => {
  const templates = [word('HELLO', ramp(0)), word('HELLO', ramp(0, 0.1)), word('YES', ramp(1)), word('NO', ramp(2)), word('TIME', ramp(3))]

  it('accepts the nearest word, with the next distinct labels as alternatives', () => {
    const c = recognizer(templates).classifyDynamic(ramp(0, 0.3, 20))
    expect(c.status).toBe('accepted')
    expect(c.label).toBe('HELLO')
    expect(c.kind).toBe('word')
    expect(c.distance).toBeCloseTo(0.2, 6)
    expect(c.alternatives).toHaveLength(3)
    expect(c.alternatives[0]).toBe('HELLO')
    expect(new Set(c.alternatives).size).toBe(3)
  })

  it('rejects a match beyond the threshold, still listing the nearest labels', () => {
    const c = recognizer(templates).classifyDynamic(ramp(0, 1.5))
    expect(c.status).toBe('rejected')
    expect(c.label).toBeUndefined()
    expect(c.distance).toBeCloseTo(1.4, 6)
    expect(c.alternatives[0]).toBe('HELLO')
  })

  it('scales the reject threshold with sensitivity', () => {
    const r = recognizer(templates)
    const query = ramp(0, 1.15) // 1.05 from the nearest HELLO
    expect(r.classifyDynamic(query).status).toBe('rejected')
    r.setSensitivity(SENSITIVITY.high)
    expect(r.classifyDynamic(query).status).toBe('accepted')
    r.setSensitivity(SENSITIVITY.low)
    expect(r.classifyDynamic(ramp(0, 0.95)).status).toBe('rejected')
  })

  it('is ambiguous when another label is nearly as close', () => {
    const r = recognizer([word('MUSIC', ramp(0, 0.2)), word('SONG', ramp(0, -0.22)), word('YES', ramp(1))])
    const c = r.classifyDynamic(ramp(0))
    expect(c.status).toBe('ambiguous')
    expect(c.label).toBe('MUSIC')
    expect(c.alternatives.slice(0, 2)).toEqual(['MUSIC', 'SONG'])
  })

  it('is not ambiguous when the runner-up is the same label', () => {
    const r = recognizer([word('MUSIC', ramp(0, 0.2)), word('MUSIC', ramp(0, -0.21)), word('YES', ramp(1))])
    expect(r.classifyDynamic(ramp(0)).status).toBe('accepted')
  })

  it('ignores words in letters mode and skips malformed templates', () => {
    const r = recognizer([...templates, word('BAD', [[1, 2, 3], [4, 5, 6]])])
    expect(r.classifyDynamic(ramp(0, 0.5)).alternatives).not.toContain('BAD')
    r.setMode('letters')
    expect(r.classifyDynamic(ramp(0)).status).toBe('rejected')
    r.setMode('words')
    expect(r.classifyDynamic(ramp(0)).status).toBe('accepted')
  })
})

describe('Recognizer.classifyStatic', () => {
  const templates = [
    letter('A', point(0, 1), point(0, 1.1)),
    letter('A', point(0, 0.9)),
    letter('B', point(1, 1)),
    letter('C', point(2, 1))
  ]

  it('accepts the voted letter', () => {
    const c = recognizer(templates).classifyStatic(point(0, 1.05))
    expect(c).toMatchObject({ status: 'accepted', label: 'A', kind: 'letter' })
    expect(c.distance).toBeCloseTo(0.05, 6)
    expect(c.alternatives).toEqual(['A', 'B', 'C'])
  })

  it('is ambiguous between two equally close letters', () => {
    const r = recognizer([letter('M', point(0, 0.3)), letter('N', point(1, 0.3))])
    const c = r.classifyStatic(point(2, 0.1))
    expect(c.status).toBe('ambiguous')
    expect(c.alternatives).toEqual(expect.arrayContaining(['M', 'N']))
  })

  it('rejects far shapes, wrong-sized vectors and words-only mode', () => {
    const r = recognizer(templates)
    expect(r.classifyStatic(point(5, 3)).status).toBe('rejected')
    expect(r.classifyStatic([1, 2, 3]).status).toBe('rejected')
    r.setMode('words')
    expect(r.classifyStatic(point(0, 1)).status).toBe('rejected')
  })
})
