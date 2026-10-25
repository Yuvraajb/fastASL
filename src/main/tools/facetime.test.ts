import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exec } from '../mac/exec'
import { pressFaceTimeCall } from '../mac/faceTimeCall'
import { SEP, runAppleScript } from '../mac/osascript'
import { faceTimeCall, faceTimeUrl } from './facetime'

// Nobody is ever called: `open` and every AppleScript (Contacts lookup) call are mocked.
vi.mock('../mac/exec', () => ({ exec: vi.fn(async () => '') }))
vi.mock('../mac/faceTimeCall', () => ({ pressFaceTimeCall: vi.fn(async () => ({ pressed: true })) }))
vi.mock('../mac/osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/osascript')>()),
  runAppleScript: vi.fn()
}))

const execMock = vi.mocked(exec)
const runMock = vi.mocked(runAppleScript)
const LABEL = '\u001c'
const card = (name: string, phone: string, email = ''): string =>
  [name, phone ? `_$!<Mobile>!$_${LABEL}${phone}` : '', email ? `_$!<Home>!$_${LABEL}${email}` : ''].join(SEP.field)

beforeEach(() => {
  execMock.mockClear()
  runMock.mockReset()
})

describe('faceTimeUrl', () => {
  it('builds video and audio links for numbers and emails', () => {
    expect(faceTimeUrl('+14085550142', false)).toBe('facetime://+14085550142')
    expect(faceTimeUrl('+14085550142', true)).toBe('facetime-audio://+14085550142')
    expect(faceTimeUrl('dad@example.com', false)).toBe('facetime://dad@example.com')
  })

  it('refuses anything that is not a plain number or email', () => {
    expect(() => faceTimeUrl('Dad', false)).toThrow(`Can't call "Dad" with FaceTime`)
    expect(() => faceTimeUrl('x@y.com/../evil', false)).toThrow()
    expect(() => faceTimeUrl('', false)).toThrow()
  })
})

describe('facetime_call', () => {
  it('needs a confirmation card that names the person and the kind of call', () => {
    expect(faceTimeCall.risk).toBe('write')
    expect(faceTimeCall.confirmDetails?.({ contact_name: 'Dad', audio_only: false })).toEqual({
      kind: 'generic',
      title: 'FaceTime video call',
      lines: ['To: Dad']
    })
    expect(faceTimeCall.stepLabel({ contact_name: 'Dad', audio_only: true })).toBe('Calling Dad')
  })

  it("calls the exact contact's mobile number with video by default", async () => {
    runMock.mockResolvedValueOnce([card('Srikar Dad', '+1 555 0100'), card('Dad', '+1 (408) 555-0178', 'dad@example.com')].join(SEP.record))
    expect(await faceTimeCall.run({ contact_name: 'Dad', audio_only: false })).toEqual({
      ok: true,
      text: 'Started a FaceTime video call to Dad (+14085550178) in FaceTime.',
      title: 'Calling Dad',
      subtitle: 'FaceTime video',
      view: { kind: 'openApp', app: 'FaceTime' }
    })
    expect(execMock).toHaveBeenCalledWith('open', ['facetime://+14085550178'])
  })

  it("says so when Call couldn't be pressed (no Accessibility access): the user presses it", async () => {
    vi.mocked(pressFaceTimeCall).mockResolvedValueOnce({ pressed: false, error: 'not allowed assistive access' })
    expect(await faceTimeCall.run({ contact_name: '+14085550100', audio_only: false })).toMatchObject({
      ok: true,
      title: 'Calling +14085550100',
      subtitle: 'Press Call in FaceTime'
    })
  })

  it('calls a typed number or email without looking anyone up', async () => {
    await faceTimeCall.run({ contact_name: '+1 408 555 0100', audio_only: true })
    expect(execMock).toHaveBeenCalledWith('open', ['facetime-audio://+14085550100'])
    expect(runMock).not.toHaveBeenCalled()
  })

  it('never calls a guess: a name with no exact match is refused before FaceTime opens', async () => {
    runMock.mockResolvedValueOnce([card("Abhinandan's Mom", '+1 555 0101'), card('Mom Machli', '+1 555 0102')].join(SEP.record))
    await expect(faceTimeCall.run({ contact_name: 'Mom', audio_only: false })).rejects.toThrow(
      'No contact is named exactly “Mom”. Did you mean Mom Machli'
    )
    expect(execMock).not.toHaveBeenCalled()
  })
})
