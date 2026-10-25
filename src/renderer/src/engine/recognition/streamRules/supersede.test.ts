import { describe, expect, it } from 'vitest'
import { supersede } from './supersede'

describe('supersede (FRIEND over TIME)', () => {
  it('FRIEND right after TIME takes its place: the TIME was its first hook', () => {
    expect(supersede({ word: 'time', t: 1000 }, 'friend', 2400)).toBe('replace')
    expect(supersede({ word: 'time', t: 1000 }, 'friend', 2600)).toBe('keep')
  })

  it('TIME right after FRIEND is dropped: the hands are still hooking', () => {
    expect(supersede({ word: 'friend', t: 1000 }, 'time', 3400)).toBe('drop')
    expect(supersede({ word: 'friend', t: 1000 }, 'time', 3600)).toBe('keep')
  })

  it('leaves every other pair alone', () => {
    expect(supersede(null, 'friend', 0)).toBe('keep')
    expect(supersede({ word: 'meeting', t: 1000 }, 'time', 1200)).toBe('keep')
    expect(supersede({ word: 'time', t: 1000 }, 'what', 1200)).toBe('keep')
    expect(supersede({ word: 'call', t: 1000 }, 'friend', 1200)).toBe('keep')
  })
})
