import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCaptionsControl } from '../captionsControl'
import { selectFaceTimeCamera, startObsCamera } from '../mac/callCamera'
import { cameraNote, captionsOff, captionsOn, withLiveCaptions } from './captions'
import { faceTimeCall } from './facetime'
import { TOOLS } from './index'
import type { ToolDef } from './types'

vi.mock('../mac/callCamera', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/callCamera')>()),
  startObsCamera: vi.fn(async () => 'started'),
  selectFaceTimeCamera: vi.fn(async () => 'selected')
}))

afterEach(() => setCaptionsControl(null))

describe('captions_on / captions_off', () => {
  it('are read tools with short step labels (no confirm card: the call itself was confirmed)', () => {
    expect(captionsOn.risk).toBe('read')
    expect(captionsOff.risk).toBe('read')
    expect(captionsOn.stepLabel({})).toBe('Turning on live captions')
    expect(captionsOff.stepLabel({})).toBe('Turning off live captions')
  })

  it('open and close the caption window through the app, and the call\'s camera becomes the caption feed', async () => {
    const open = vi.fn()
    const close = vi.fn()
    setCaptionsControl({ open, close })
    const on = await captionsOn.run({})
    expect(on).toMatchObject({ ok: true, title: 'Live captions on', subtitle: "The call's camera is OBS Virtual Camera" })
    expect(on.text).toContain('OBS Virtual Camera started. FaceTime is using OBS Virtual Camera.')
    expect(open).toHaveBeenCalledTimes(1)
    expect(startObsCamera).toHaveBeenCalledTimes(1)
    expect(selectFaceTimeCamera).toHaveBeenCalledTimes(1)
    expect(await captionsOff.run({})).toMatchObject({ ok: true, title: 'Live captions off' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('fail softly before the app has set the window up', async () => {
    expect(await captionsOn.run({})).toMatchObject({ ok: false })
    expect(await captionsOff.run({})).toMatchObject({ ok: false })
  })
})

describe('cameraNote', () => {
  it('says what worked', () => {
    expect(cameraNote('started', 'selected')).toBe('OBS Virtual Camera started. FaceTime is using OBS Virtual Camera.')
    expect(cameraNote('already-on', 'selected')).toBe('FaceTime is using OBS Virtual Camera.')
  })

  it('says how to finish by hand what did not', () => {
    expect(cameraNote('not-running', 'no-camera')).toContain('open OBS and click Start Virtual Camera')
    expect(cameraNote('started', 'no-camera')).toContain('pick it under Video > Camera')
    expect(cameraNote('started', 'no-facetime')).toContain('FaceTime is not open yet')
    expect(cameraNote('failed', 'failed')).toContain('Accessibility')
    expect(cameraNote('not-started', 'no-camera')).toContain('approve the OBS camera extension')
  })
})

describe('a video call starts with the live caption camera by default', () => {
  const placed = { ok: true, text: 'Opened FaceTime to start a call to Mom.', title: 'Calling Mom', subtitle: 'FaceTime video' }
  const call = (ok = true): ToolDef & { calls: number } => {
    const tool = { ...faceTimeCall, calls: 0, run: vi.fn(async () => (ok ? placed : { ok: false, text: "Couldn't call" })) } as unknown as ToolDef & { calls: number }
    return tool
  }

  it('is how the agent places every call: the registered FaceTime tool is the wrapped one', () => {
    const registered = TOOLS.find((t) => t.name === 'facetime_call')!
    expect(registered.run).not.toBe(faceTimeCall.run)
    expect(registered.risk).toBe('write') // the confirm card is unchanged
  })

  it('places the call, then opens the captions and switches the camera, in that order', async () => {
    const open = vi.fn()
    setCaptionsControl({ open, close: vi.fn() })
    const tool = withLiveCaptions(call())
    const out = await tool.run({ contact_name: 'Mom', audio_only: false })
    expect(out).toMatchObject({ ok: true, title: 'Calling Mom', subtitle: 'FaceTime video · live captions' })
    expect(out.text).toContain('Opened FaceTime to start a call to Mom.')
    expect(out.text).toContain('FaceTime is using OBS Virtual Camera.')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('leaves an audio-only call and a call that did not start without captions', async () => {
    const open = vi.fn()
    setCaptionsControl({ open, close: vi.fn() })
    expect(await withLiveCaptions(call()).run({ contact_name: 'Mom', audio_only: true })).toEqual(placed)
    expect(await withLiveCaptions(call(false)).run({ contact_name: 'Mom', audio_only: false })).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })

  it('still reports the call as placed when the captions cannot start', async () => {
    setCaptionsControl(null)
    const out = await withLiveCaptions(call()).run({ contact_name: 'Mom', audio_only: false })
    expect(out).toMatchObject({ ok: true, title: 'Calling Mom', subtitle: 'FaceTime video' })
    expect(out.text).toContain("Captions aren't available yet")
  })
})
