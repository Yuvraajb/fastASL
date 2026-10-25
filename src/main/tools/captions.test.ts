import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCaptionsControl } from '../captionsControl'
import { captionsOff, captionsOn } from './captions'

afterEach(() => setCaptionsControl(null))

describe('captions_on / captions_off', () => {
  it('are read tools with short step labels (no confirm card: the call itself was confirmed)', () => {
    expect(captionsOn.risk).toBe('read')
    expect(captionsOff.risk).toBe('read')
    expect(captionsOn.stepLabel({})).toBe('Turning on live captions')
    expect(captionsOff.stepLabel({})).toBe('Turning off live captions')
  })

  it('open and close the caption window through the app', async () => {
    const open = vi.fn()
    const close = vi.fn()
    setCaptionsControl({ open, close })
    expect(await captionsOn.run({})).toMatchObject({ ok: true, title: 'Live captions on' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(await captionsOff.run({})).toMatchObject({ ok: true, title: 'Live captions off' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('fail softly before the app has set the window up', async () => {
    expect(await captionsOn.run({})).toMatchObject({ ok: false })
    expect(await captionsOff.run({})).toMatchObject({ ok: false })
  })
})
