import { describe, expect, it } from 'vitest'
import { dtw, euclidean, resample } from './dtw'

/** A 2-D trajectory sampled at n points, with an optional time warp u -> warp(u). */
function curve(n: number, fn: (u: number) => [number, number], warp = (u: number): number => u): number[][] {
  return Array.from({ length: n }, (_, i) => fn(warp(i / (n - 1))))
}

const circle = (u: number): [number, number] => [Math.cos(2 * Math.PI * u), Math.sin(2 * Math.PI * u)]
const line = (u: number): [number, number] => [2 * u - 1, 0.5]

describe('resample', () => {
  it('linearly interpolates to the requested length, keeping both ends', () => {
    expect(resample([[0], [10]], 5)).toEqual([[0], [2.5], [5], [7.5], [10]])
    expect(resample([[0, 0], [2, 4], [4, 0]], 5)).toEqual([[0, 0], [1, 2], [2, 4], [3, 2], [4, 0]])
  })

  it('downsamples by picking interpolated points', () => {
    const seq = Array.from({ length: 64 }, (_, i) => [i])
    const out = resample(seq, 32)
    expect(out).toHaveLength(32)
    expect(out[0]).toEqual([0])
    expect(out[31]).toEqual([63])
    out.forEach(([v], i) => expect(v).toBeCloseTo((i * 63) / 31, 9))
  })

  it('handles degenerate inputs', () => {
    expect(resample([], 32)).toEqual([])
    expect(resample([[3, 4]], 3)).toEqual([[3, 4], [3, 4], [3, 4]])
    expect(resample([[0], [1], [2]], 32)).toHaveLength(32)
  })
})

describe('dtw', () => {
  it('is 0 for identical sequences', () => {
    const a = curve(32, circle)
    expect(dtw(a, a)).toBe(0)
    expect(dtw(a, a, { band: 0 })).toBe(0)
  })

  it('is normalized by path length (a constant offset gives exactly that offset)', () => {
    const a = curve(20, line)
    const b = a.map(([x, y]) => [x, y + 0.3])
    expect(dtw(a, b)).toBeCloseTo(0.3, 9)
  })

  it('finds a time-warped copy much closer than a different movement', () => {
    const base = resample(curve(40, circle))
    const warped = resample(curve(55, circle, (u) => u * u * (3 - 2 * u)))
    const other = resample(curve(40, line))
    const lockstep = dtw(base, warped, { band: 0 })
    const warpedDistance = dtw(base, warped, { band: 6 })
    expect(warpedDistance).toBeLessThan(lockstep / 2)
    expect(dtw(base, other, { band: 6 })).toBeGreaterThan(warpedDistance * 5)
  })

  it('band 0 compares frames in lock-step; wider bands never cost more', () => {
    const a = resample(curve(30, circle))
    const b = resample(curve(30, circle, (u) => Math.sqrt(u)))
    const lockstep = a.reduce((s, f, i) => s + euclidean(f, b[i]), 0) / a.length
    expect(dtw(a, b, { band: 0 })).toBeCloseTo(lockstep, 9)
    let last = Infinity
    for (const band of [0, 1, 2, 4, 8, Infinity]) {
      const d = dtw(a, b, { band })
      expect(d).toBeLessThanOrEqual(last + 1e-12)
      last = d
    }
    expect(dtw(a, b, { band: 2 })).toBeGreaterThan(dtw(a, b))
  })

  it('handles unequal lengths and impossible inputs', () => {
    const a = curve(10, circle)
    const b = curve(25, circle)
    expect(dtw(a, b, { band: 2 })).toBeLessThan(0.2)
    expect(dtw([], b)).toBe(Infinity)
    expect(dtw([[0, 0]], b, { band: 1 })).toBe(Infinity) // the band cannot reach the far corner
  })
})
