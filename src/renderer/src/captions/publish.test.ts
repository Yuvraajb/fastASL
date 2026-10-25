import { describe, expect, it } from 'vitest'
import { captionStateOf } from './publish'

describe('captionStateOf', () => {
  it('shows the words being signed live, and the last sent message', () => {
    const s = {
      composing: { tokens: [{ text: 'call', kind: 'word' as const }, { text: 'friend', kind: 'word' as const }] },
      chat: [
        { id: '1', from: 'you' as const, kind: 'text' as const, text: 'Hello' },
        { id: '2', from: 'agent' as const, kind: 'text' as const, text: 'Hi!' },
        { id: '3', from: 'you' as const, kind: 'text' as const, text: 'Tomorrow meeting what time' }
      ]
    }
    expect(captionStateOf(s, 42)).toEqual({ live: 'call friend', last: 'Tomorrow meeting what time', lastAt: 42 })
    expect(captionStateOf({ composing: { tokens: [] }, chat: [] }, 0)).toEqual({ live: '', last: '', lastAt: 0 })
  })
})
