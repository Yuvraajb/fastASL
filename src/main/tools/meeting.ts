import { z } from 'zod'
import type { ConfirmDetails } from '@shared/types'
import { arrangeMailAndCalendar } from '../mac/arrange'
import { isIsoDate, parseIsoDate } from '../mac/dates'
import { readDefault } from '../mac/exec'
import { runAppleScript } from '../mac/osascript'
import { createEventScript, parseCreatedEvent } from './calendar'
import { findContact } from './contacts'
import { clockTime, dateLabel, timeRangeLabel, truncate } from './format'
import { revealSentScript, sendMailScript } from './mail'
import { fail } from './outcome'
import { defineTool } from './types'

const isoString = z.string().refine(isIsoDate, { message: 'Use an ISO 8601 date-time, e.g. 2026-10-25T14:00:00' })

/** "Today, Oct 25, 2:00 – 3:00 PM". */
function whenLabel(start: Date, end: Date, now: Date): string {
  return `${dateLabel(start, now)}, ${timeRangeLabel(start, end)}`
}

/** "today" / "tomorrow" / "on Friday, Oct 30", for the email's subject and text. */
function dayWords(start: Date, now: Date): string {
  const label = dateLabel(start, now)
  if (label.startsWith('Today')) return 'today'
  if (label.startsWith('Tomorrow')) return 'tomorrow'
  return `on ${label}`
}

export function meetingConfirmDetails(args: { contact_name: string; start_iso: string; end_iso: string }, now: Date): ConfirmDetails {
  const start = parseIsoDate(args.start_iso)
  const end = parseIsoDate(args.end_iso)
  const when = start && end ? whenLabel(start, end, now) : `${args.start_iso} – ${args.end_iso}`
  return {
    kind: 'generic',
    title: `Meeting with ${args.contact_name}`,
    lines: [when, `Calendar invite to ${args.contact_name}`, `Email ${args.contact_name} the time`]
  }
}

/** The email that goes with the invite. */
export function meetingEmail(name: string, start: Date, end: Date, now: Date): { subject: string; body: string } {
  const first = name.split(/\s+/)[0] || name
  return {
    subject: `Meeting ${dayWords(start, now)} at ${clockTime(start)}`,
    body: `Hi ${first},\n\nLet's meet ${dayWords(start, now)}, ${timeRangeLabel(start, end)}. I've sent you a calendar invite.\n\nSent with fastASL`
  }
}

/**
 * MEETING FRIEND, then a time picked by fingers: one confirmed action that puts Mail (top left)
 * and Calendar (bottom left) on screen, creates the event with the contact invited, and emails
 * them the time. One write, so one Confirm card for both.
 */
export const meetingInvite = defineTool({
  name: 'meeting_invite',
  description:
    'Set up a meeting with one person: shows Mail and Calendar on the left of the screen, creates the event ' +
    'with them invited, and emails them the time. contact_name: full name as saved in Contacts (they need an ' +
    'email address). Times are ISO 8601, local time zone without an offset.',
  schema: {
    contact_name: z.string().trim().min(1),
    start_iso: isoString,
    end_iso: isoString
  },
  risk: 'write',
  stepLabel: (args) => truncate(`Setting up a meeting with ${args.contact_name}`, 44),
  confirmDetails: (args) => meetingConfirmDetails(args, new Date()),
  async run(args) {
    const start = parseIsoDate(args.start_iso)
    const end = parseIsoDate(args.end_iso)
    if (!start || !end || end <= start) return fail('Use ISO 8601 start and end times, the end after the start')
    const contact = await findContact(args.contact_name)
    const email = contact.emails[0]?.value
    if (!email) return fail(`${contact.name} has no email address in Contacts. Add one to invite and email them.`)

    await arrangeMailAndCalendar(start)
    const now = new Date()
    const when = whenLabel(start, end, now)
    const title = `Meeting with ${contact.name}`
    const calendarId = (await readDefault('com.apple.iCal', 'defaultCalendarID')) ?? undefined
    const script = createEventScript({ title, start, end, attendees: [email], notes: 'Set up in fastASL.', calendarId, reveal: true })
    const created = parseCreatedEvent(await runAppleScript(script, { app: 'Calendar', launch: true, timeoutMs: 30_000 }))
    if (!created) return fail('Calendar did not confirm the new event')

    const { subject, body } = meetingEmail(contact.name, start, end, now)
    const sent = await runAppleScript(sendMailScript({ to: [email], subject, body }), { app: 'Mail', launch: true, timeoutMs: 30_000 })
    if (sent !== 'true') {
      return fail(`"${title}" is in Calendar (${when}), but Mail did not send the email. Check that a Mail account is set up.`)
    }
    // Show what was sent: the Sent mailbox with this email selected (for show only, never fails the action).
    await runAppleScript(revealSentScript(subject), { app: 'Mail', timeoutMs: 20_000 }).catch(() => null)
    const invited = created.guests > 0 ? `${email} invited` : `no invite sent (the "${created.calendar}" calendar doesn't send them)`
    return {
      ok: true,
      text: `Created "${title}" in ${created.calendar} (${when}), ${invited}, and emailed ${email} "${subject}".`,
      title: 'Meeting set up',
      subtitle: truncate(`${when} · ${created.guests > 0 ? 'invite + email sent' : 'email sent'}`, 60),
      view: { kind: 'openApp', app: 'Calendar' }
    }
  }
})
