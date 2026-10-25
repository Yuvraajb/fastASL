import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApp, useApp } from '../app/store'
import { captionStateOf, publishCaptions } from './publish'

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
    // Captions off (the button): nothing shows, though words are being signed.
    expect(captionStateOf({ ...s, captioning: false }, 42)).toEqual({ live: '', last: '', lastAt: 0 })
  })
})

describe('publishCaptions', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    useApp.setState(useApp.getInitialState(), true)
  })

  it('sends again when the same words are sent again, with a new time', () => {
    vi.useFakeTimers()
    const sendCaptions = vi.fn()
    vi.stubGlobal('window', { fastasl: { sendCaptions } })
    setApp({ captioning: true })
    const stop = publishCaptions()
    setApp({ chat: [{ id: 'm1', from: 'you', kind: 'text', text: 'Yes' }] })
    vi.advanceTimersByTime(5000)
    setApp({ chat: [{ id: 'm1', from: 'you', kind: 'text', text: 'Yes' }, { id: 'm2', from: 'you', kind: 'text', text: 'Yes' }] })
    stop()
    expect(sendCaptions).toHaveBeenCalledTimes(2)
    const [first, second] = sendCaptions.mock.calls.map(([state]) => state)
    expect(first.last).toBe('Yes')
    expect(second.last).toBe('Yes')
    expect(second.lastAt - first.lastAt).toBe(5000)
  })
})
