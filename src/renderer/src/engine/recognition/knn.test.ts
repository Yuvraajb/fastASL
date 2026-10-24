import { describe, expect, it } from 'vitest'
import { knn } from './knn'

const at = (label: string, x: number, y = 0): { label: string; vector: number[] } => ({ label, vector: [x, y] })

describe('knn', () => {
  it('returns null without samples', () => {
    expect(knn([0, 0], [])).toBeNull()
  })

  it('returns the best label, its nearest distance and the runner-up', () => {
    const samples = [at('A', 1), at('A', 1.2), at('B', 3), at('C', 5)]
    const r = knn([0, 0], samples)!
    expect(r.label).toBe('A')
    expect(r.distance).toBeCloseTo(1)
    expect(r.second).toEqual({ label: 'B', distance: 3 })
    expect(r.ranked.map((n) => n.label)).toEqual(['A', 'B', 'C'])
  })

  it('lets two close neighbors outvote one slightly closer outlier', () => {
    const samples = [at('X', 1), at('Y', 1.1), at('Y', 1.15), at('X', 9)]
    const r = knn([0, 0], samples, 3)!
    expect(r.label).toBe('Y')
    expect(r.distance).toBeCloseTo(1.1)
    expect(r.second).toEqual({ label: 'X', distance: 1 })
  })

  it('weights votes by distance, so one exact match wins over two far ones', () => {
    const samples = [at('X', 0.01), at('Y', 2), at('Y', 2.1)]
    expect(knn([0, 0], samples)!.label).toBe('X')
  })

  it('has no runner-up when only one label exists', () => {
    const r = knn([0, 0], [at('A', 1), at('A', 2)])!
    expect(r.second).toBeNull()
    expect(r.ranked).toHaveLength(1)
  })
})
