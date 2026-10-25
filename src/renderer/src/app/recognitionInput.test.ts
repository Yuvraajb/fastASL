import { describe, expect, it } from 'vitest'
import { nextInitials } from './recognitionInput'

describe('nextInitials (CALL D W, MEETING D W)', () => {
  const letter = (text: string) => ({ text, kind: 'letter' as const })
  const word = (text: string) => ({ text, kind: 'word' as const })
  const state = (tokens: { text: string; kind: 'word' | 'letter' }[], mode: 'command' | 'spell' = 'command') => ({
    mode,
    composing: { tokens },
    contactAliases: { dw: 'Darren Wu', friend: 'Darren Wu' }
  })

  it('after CALL / MEETING, the next letter of an initials nickname: D, then W, then nothing', () => {
    expect(nextInitials(state([word('call')]))).toEqual(['D'])
    expect(nextInitials(state([word('meeting')]))).toEqual(['D'])
    expect(nextInitials(state([word('call'), letter('D')]))).toEqual(['W'])
    expect(nextInitials(state([word('call'), letter('D'), letter('W')]))).toEqual([])
  })

  it('nowhere else: no command word, another word last, or Spell mode', () => {
    expect(nextInitials(state([]))).toEqual([])
    expect(nextInitials(state([word('hello')]))).toEqual([])
    expect(nextInitials(state([word('call'), word('friend')]))).toEqual([])
    expect(nextInitials(state([word('call')], 'spell'))).toEqual([])
  })
})
