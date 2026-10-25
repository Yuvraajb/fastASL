import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SEP, runAppleScript } from '../mac/osascript'
import { findContact } from './contacts'
import { meetingConfirmDetails, meetingEmail, meetingInvite } from './meeting'

// Nobody is invited or emailed: Contacts, Calendar, Mail and the window placement are mocked.
vi.mock('../mac/osascript', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mac/osascript')>()), runAppleScript: vi.fn() }))
vi.mock('../mac/arrange', () => ({ arrangeMailAndCalendar: vi.fn(async () => ({ mail: true, calendar: true })) }))
vi.mock('../mac/exec', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mac/exec')>()), readDefault: vi.fn(async () => null) }))
vi.mock('./contacts', async (importOriginal) => ({ ...(await importOriginal<typeof import('./contacts')>()), findContact: vi.fn() }))

const run = vi.mocked(runAppleScript)
const contact = vi.mocked(findContact)
const ARGS = { contact_name: 'Darren Wu', start_iso: '2026-10-25T14:00:00', end_iso: '2026-10-25T15:00:00' }
const now = new Date(2026, 9, 25, 10, 0)

beforeEach(() => {
  run.mockReset()
  contact.mockReset()
})

describe('meeting_invite', () => {
  it('is one write with one Confirm card naming the time, the invite and the email', () => {
    expect(meetingInvite.risk).toBe('write')
    expect(meetingConfirmDetails(ARGS, now)).toEqual({
      kind: 'generic',
      title: 'Meeting with Darren Wu',
      lines: ['Today, Oct 25, 2:00 – 3:00 PM', 'Calendar invite to Darren Wu', 'Email Darren Wu the time']
    })
  })

  it('writes the email from the time', () => {
    expect(meetingEmail('Darren Wu', new Date(2026, 9, 26, 13), new Date(2026, 9, 26, 14), now)).toEqual({
      subject: 'Meeting tomorrow at 1:00 PM',
      body: "Hi Darren,\n\nLet's meet tomorrow, 1:00 – 2:00 PM. I've sent you a calendar invite.\n\nSent with fastASL"
    })
  })

  it('refuses a contact with no email before anything opens or is created', async () => {
    contact.mockResolvedValue({ name: 'Darren Wu', phones: [{ label: 'mobile', value: '+15555550100' }], emails: [] } as never)
    expect(await meetingInvite.run(ARGS)).toEqual({ ok: false, text: 'Darren Wu has no email address in Contacts. Add one to invite and email them.' })
    expect(run).not.toHaveBeenCalled()
  })

  it('creates the event with them invited, then emails them', async () => {
    contact.mockResolvedValue({ name: 'Darren Wu', phones: [], emails: [{ label: 'home', value: 'darren@example.com' }] } as never)
    const created = ['Meeting with Darren Wu', '2026-10-25T14:00:00', '2026-10-25T15:00:00', '1', 'Calendar'].join(SEP.field)
    run.mockImplementation(async (script: string) => (script.includes('outgoing message') ? 'true' : created))
    const outcome = await meetingInvite.run(ARGS)
    const scripts = run.mock.calls.map(([s]) => s as string)
    expect(scripts).toHaveLength(2)
    expect(scripts[0]).toContain('Meeting with Darren Wu')
    expect(scripts[0]).toContain('darren@example.com')
    expect(scripts[1]).toContain('outgoing message')
    expect(scripts[1]).toContain('darren@example.com')
    expect(outcome).toMatchObject({ ok: true, title: 'Meeting set up' })
    expect(outcome.subtitle).toContain('invite + email sent')
  })

  it('no event read back: stops before the email', async () => {
    contact.mockResolvedValue({ name: 'Darren Wu', phones: [], emails: [{ label: 'home', value: 'darren@example.com' }] } as never)
    run.mockResolvedValue('')
    expect(await meetingInvite.run(ARGS)).toEqual({ ok: false, text: 'Calendar did not confirm the new event' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
