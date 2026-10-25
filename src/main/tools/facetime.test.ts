import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exec } from '../mac/exec'
import { SEP, runAppleScript, runJxa } from '../mac/osascript'
import { confirmCallJxa, faceTimeCall, faceTimeUrl } from './facetime'

// Nobody is ever called: `open` and every AppleScript (Contacts lookup) call are mocked.
vi.mock('../mac/exec', () => ({ exec: vi.fn(async () => '') }))
vi.mock('../mac/osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/osascript')>()),
  runAppleScript: vi.fn(),
  runJxa: vi.fn()
}))

const execMock = vi.mocked(exec)
const runMock = vi.mocked(runAppleScript)
const jxaMock = vi.mocked(runJxa)
const LABEL = '\u001c'
const card = (name: string, phone: string, email = ''): string =>
  [name, phone ? `_$!<Mobile>!$_${LABEL}${phone}` : '', email ? `_$!<Home>!$_${LABEL}${email}` : ''].join(SEP.field)

beforeEach(() => {
  execMock.mockClear()
  jxaMock.mockReset()
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
    jxaMock.mockResolvedValueOnce('true')
    expect(await faceTimeCall.run({ contact_name: 'Dad', audio_only: false })).toEqual({
      ok: true,
      text: 'Started a FaceTime video call to Dad (+14085550178).',
      title: 'Calling Dad',
      subtitle: 'FaceTime video',
      view: { kind: 'openApp', app: 'FaceTime' }
    })
    expect(execMock).toHaveBeenCalledWith('open', ['facetime://+14085550178'])
  })

  it('calls a typed number or email without looking anyone up', async () => {
    await faceTimeCall.run({ contact_name: '+1 408 555 0100', audio_only: true })
    expect(execMock).toHaveBeenCalledWith('open', ['facetime-audio://+14085550100'])
    // No Contacts lookup: the only scripting is the accessibility click.
    expect(runMock).not.toHaveBeenCalled()
    expect(jxaMock).toHaveBeenCalledTimes(1)
    expect(String(jxaMock.mock.calls[0][0])).toContain("processes.byName('FaceTime')")
  })

  it('still reports the call when Accessibility refuses the click', async () => {
    runMock.mockResolvedValueOnce('') // Contacts lookup: nobody
    jxaMock.mockRejectedValueOnce(new Error('Not authorized to send Apple events'))
    const out = await faceTimeCall.run({ contact_name: '+1 408 555 0199', audio_only: false })
    expect(out.ok).toBe(true)
    expect(out.text).toContain('press Call to connect')
  })

  it('never calls a guess: a name with no exact match is refused before FaceTime opens', async () => {
    runMock.mockResolvedValueOnce([card("Abhinandan's Mom", '+1 555 0101'), card('Mom Machli', '+1 555 0102')].join(SEP.record))
    await expect(faceTimeCall.run({ contact_name: 'Mom', audio_only: false })).rejects.toThrow(
      'No contact is named exactly “Mom”. Did you mean Mom Machli'
    )
    expect(execMock).not.toHaveBeenCalled()
  })
})

describe('pressing Call for the user', () => {
  it("finds FaceTime's Call button by its description, which is language dependent", () => {
    const script = confirmCallJxa()
    expect(script).toContain('entireContents')
    expect(script).toContain("e.role() !== 'AXButton'")
    expect(script).toContain('AXPress')
    expect(script).toContain('call|appeler|llamar')
    // Success is only reported when the Call button actually disappeared.
    expect(script).toContain("return find() ? 'false' : 'true'")
  })
})
