import { describe, expect, it } from 'vitest'
import type { FrameSample } from '../types'
import { InitialsSpotter } from './initials'
import { performHolds, rng, timeline, type ShapeName } from './synthetic'

const ASPECT = 4 / 3
const hold = (shape: ShapeName, holdMs: number, seed: number) => (t0: number) =>
  performHolds([{ shape, holdMs }], { random: rng(seed), aspect: ASPECT, t0 })

function spot(frames: FrameSample[], letters: readonly string[] = ['D', 'W']): string[] {
  const spotter = new InitialsSpotter()
  return frames.flatMap((f) => spotter.update(f, ASPECT, letters) ?? [])
}

describe('InitialsSpotter (D and W, untaught)', () => {
  it('a held D is D and a held W is W, once per hold', () => {
    expect(spot(timeline([hold('D', 1500, 61)]))).toEqual(['D'])
    expect(spot(timeline([hold('W', 1500, 62)]))).toEqual(['W'])
    expect(spot(timeline([hold('D', 1500, 63), hold('W', 1500, 64)]))).toEqual(['D', 'W'])
  })

  it('needs about half a second: a passing shape is nothing', () => {
    expect(spot(timeline([hold('D', 250, 65)]))).toEqual([])
  })

  it('only the letters asked for, and not other shapes', () => {
    expect(spot(timeline([hold('D', 1500, 66)]), ['W'])).toEqual([])
    for (const shape of ['A', 'B', 'L', 'S', 'Y', 'V'] as const) expect(spot(timeline([hold(shape, 1500, 67)])), shape).toEqual([])
  })
})
