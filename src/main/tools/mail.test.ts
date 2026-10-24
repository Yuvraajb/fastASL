import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SEP, runAppleScript } from '../mac/osascript'
import { isEmail, mailSend, sendMailScript, splitRecipients } from './mail'
import { messageSend, sendMessageScript } from './messages'

// Nothing is ever sent: every AppleScript call is answered by this mock.
vi.mock('../mac/osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/osascript')>()),
  runAppleScript: vi.fn()
}))

const runMock = vi.mocked(runAppleScript)
const LABEL = '\u001c'
const contactRow = (name: string, phone: string, email: string): string =>
  [name, phone ? `mobile${LABEL}${phone}` : '', email ? `home${LABEL}${email}` : ''].join(SEP.field)

beforeEach(() => {
  runMock.mockReset()
})

describe('mail helpers', () => {
  it('recognizes email addresses and splits recipient lists', () => {
    expect(isEmail('ana@example.com')).toBe(true)
    expect(isEmail('Ana')).toBe(false)
    expect(isEmail('ana@localhost')).toBe(false)
    expect(splitRecipients(' a@x.com, b@x.com ; ;Sarah ')).toEqual(['a@x.com', 'b@x.com', 'Sarah'])
  })

  it('builds the expected AppleScript', () => {
    expect(sendMailScript({ to: ['a@x.com', 'b@x.com'], subject: 'Lunch "today"', body: 'Hi\nAna' })).toBe(
      [
        'tell application "Mail"',
        '\tset msg to make new outgoing message with properties {subject:"Lunch \\"today\\"", content:"Hi\\nAna", visible:false}',
        '\ttell msg',
        '\t\tmake new to recipient at end of to recipients with properties {address:"a@x.com"}',
        '\t\tmake new to recipient at end of to recipients with properties {address:"b@x.com"}',
        '\tend tell',
        '\treturn (send msg) as text',
        'end tell'
      ].join('\n')
    )
  })
})

describe('mail_send run', () => {
  it('sends to an address and reports it', async () => {
    runMock.mockResolvedValueOnce('true')
    expect(await mailSend.run({ to: 'ana@example.com', subject: 'Hi', body: 'Yo' })).toEqual({
      ok: true,
      text: 'Sent "Hi" to ana@example.com.',
      title: 'Email sent',
      subtitle: 'to ana@example.com'
    })
  })

  it('resolves an exact contact name to their email first', async () => {
    runMock.mockResolvedValueOnce(contactRow('Sarah Chen', '', 'sarah@example.com')).mockResolvedValueOnce('true')
    const outcome = await mailSend.run({ to: 'sarah chen, bo@example.com', subject: 'Hi', body: 'Yo' })
    expect(outcome.subtitle).toBe('to sarah@example.com +1')
    expect(runMock.mock.calls[0][0]).toContain('every person whose name contains "sarah"')
    expect(runMock.mock.calls[1][0]).toContain('{address:"sarah@example.com"}')
  })

  it('never mails someone whose name only contains the approved one', async () => {
    runMock.mockResolvedValueOnce(contactRow('Jordan Smith', '', 'jordan@example.com'))
    await expect(mailSend.run({ to: 'Dan', subject: 'Hi', body: 'Yo' })).rejects.toThrow('No contact named “Dan” in Contacts')
    expect(runMock).toHaveBeenCalledTimes(1) // nothing was sent
  })

  it('fails when Mail does not accept the message', async () => {
    runMock.mockResolvedValueOnce('false')
    expect((await mailSend.run({ to: 'a@x.com', subject: 's', body: 'b' })).ok).toBe(false)
  })
})

describe('message_send', () => {
  it('builds the expected AppleScript', () => {
    const script = sendMessageScript('+15550102000', 'On my way "now"')
    expect(script).toContain('set svc to first account whose service type = iMessage')
    expect(script).toContain('send "On my way \\"now\\"" to participant "+15550102000" of svc')
  })

  it('resolves the exact contact, sends to their mobile number and reports the name', async () => {
    runMock.mockResolvedValueOnce(contactRow('Sarah Chen', '+1 (555) 010-2000', '')).mockResolvedValueOnce('sent')
    expect(await messageSend.run({ contact_name: 'Sarah Chen', text: 'Hi' })).toEqual({
      ok: true,
      text: 'Sent an iMessage to Sarah Chen (+15550102000).',
      title: 'Message sent',
      subtitle: 'to Sarah Chen'
    })
    expect(runMock.mock.calls[1][0]).toContain('participant "+15550102000"')
  })

  it('sends nothing for a partial or mid-word name', async () => {
    runMock.mockResolvedValueOnce(contactRow('Sarah Chen', '+1555', ''))
    await expect(messageSend.run({ contact_name: 'Sarah', text: 'Hi' })).rejects.toThrow(
      'No contact is named exactly “Sarah”. Did you mean Sarah Chen? Use the full name.'
    )
    runMock.mockResolvedValueOnce(contactRow('Joanne Lee', '+1666', ''))
    await expect(messageSend.run({ contact_name: 'Ann', text: 'Hi' })).rejects.toThrow('No contact named “Ann” in Contacts')
    expect(runMock).toHaveBeenCalledTimes(2) // two lookups, nothing sent
  })

  it('refuses two different people with the same name', async () => {
    runMock.mockResolvedValueOnce(
      [contactRow('Chris Lee', '+1555', ''), contactRow('Chris Lee', '+1666', '')].join(SEP.record)
    )
    await expect(messageSend.run({ contact_name: 'Chris Lee', text: 'Hi' })).rejects.toThrow(
      '2 different contacts are named “Chris Lee”. Use the phone number or email instead.'
    )
    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it('accepts a phone number directly without a Contacts lookup', async () => {
    runMock.mockResolvedValueOnce('sent')
    const outcome = await messageSend.run({ contact_name: '+1 555 010 2000', text: 'Hi' })
    expect(outcome.subtitle).toBe('to +1 555 010 2000')
    expect(runMock).toHaveBeenCalledTimes(1)
    expect(runMock.mock.calls[0][0]).toContain('participant "+15550102000"')
  })
})
