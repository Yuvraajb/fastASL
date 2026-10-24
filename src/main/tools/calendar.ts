import { z } from 'zod'
import type { ConfirmDetails } from '@shared/types'
import { MAKE_DATE_HANDLER, appleScriptDate, appleScriptIso, isIsoDate, parseIsoDate } from '../mac/dates'
import { readDefault } from '../mac/exec'
import { AS_SEPARATORS, appleScriptString as q, runAppleScript, splitRecords } from '../mac/osascript'
import {
  clockTime,
  dateLabel,
  dayOffset,
  guestsLabel,
  plural,
  relativeDay,
  timeRangeLabel,
  truncate,
  videoLabel
} from './format'
import { fail } from './outcome'
import { defineTool } from './types'

const isoString = z
  .string()
  .refine(isIsoDate, { message: 'Use an ISO 8601 date-time, e.g. 2026-10-25T10:00:00' })

const addDays = (d: Date, days: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds())

// ---------------------------------------------------------------------------
// Listing

export interface CalendarEvent {
  title: string
  start: Date
  end: Date
  calendar: string
  allDay: boolean
}

export interface DateRange {
  start: Date
  end: Date
  /** Phrase for the card: "today", "tomorrow", "in the next 7 days", "on Friday, Oct 30". */
  phrase: string
}

interface RangeArgs {
  range?: 'today' | 'tomorrow' | 'week'
  start_iso?: string
  end_iso?: string
}

function dayPhrase(date: Date, now: Date): string {
  const offset = dayOffset(date, now)
  return offset >= -1 && offset <= 1 ? relativeDay(date, now).toLowerCase() : relativeDay(date, now)
}

/** Resolves the tool's range arguments to concrete local dates, or an error message. */
export function resolveRange(args: RangeArgs, now: Date): DateRange | string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!args.start_iso) {
    if (args.range === 'tomorrow') return { start: addDays(today, 1), end: addDays(today, 2), phrase: 'tomorrow' }
    if (args.range === 'week') return { start: today, end: addDays(today, 7), phrase: 'in the next 7 days' }
    return { start: today, end: addDays(today, 1), phrase: 'today' }
  }

  const start = parseIsoDate(args.start_iso)
  const end = args.end_iso ? parseIsoDate(args.end_iso) : start && addDays(start, 1)
  if (!start || !end) return 'Use ISO 8601 dates, e.g. 2026-10-25T00:00:00'
  if (end <= start) return 'end_iso must be after start_iso'

  const last = new Date(end.getTime() - 1)
  const first = dayPhrase(start, now)
  if (dayOffset(last, start) === 0) {
    return { start, end, phrase: /^(today|tomorrow|yesterday)$/.test(first) ? first : `on ${first}` }
  }
  return { start, end, phrase: `from ${first} to ${dayPhrase(last, now)}` }
}

/**
 * Each calendar is filtered with four bulk property reads (one Apple event
 * each) and the lists are zipped locally, so the date filter runs four times
 * per calendar however many events match, never once per event property.
 */
export function listEventsScript(range: { start: Date; end: Date }): string {
  return `${MAKE_DATE_HANDLER}
${AS_SEPARATORS}
set rangeStart to ${appleScriptDate(range.start)}
set rangeEnd to ${appleScriptDate(range.end)}
set out to {}
tell application "Calendar"
\tset cals to (get calendars)
\trepeat with c from 1 to count of cals
\t\tset cal to item c of cals
\t\tset {calName, titles, startDates, endDates, allDays} to {"", {}, {}, {}, {}}
\t\ttry -- one unreadable (e.g. subscribed) calendar shouldn't hide the rest
\t\t\tset calName to name of cal
\t\t\ttell (every event of cal whose start date < rangeEnd and end date > rangeStart)
\t\t\t\tset {titles, startDates, endDates, allDays} to {summary, start date, end date, allday event}
\t\t\tend tell
\t\tend try
\t\tset n to count of titles
\t\tif (count of startDates) is not n or (count of endDates) is not n or (count of allDays) is not n then error "Calendar changed while it was being read. Try again." number 9004
\t\trepeat with i from 1 to n
\t\t\tset end of out to ((item i of titles) as text) & US & ${appleScriptIso('item i of startDates')} & US & ${appleScriptIso('item i of endDates')} & US & calName & US & ((item i of allDays) as text)
\t\tend repeat
\tend repeat
end tell
set AppleScript's text item delimiters to RS
return out as text`
}

export function parseEvents(output: string): CalendarEvent[] {
  return splitRecords(output)
    .flatMap(([title = '', startIso = '', endIso = '', calendar = '', allDay = '']) => {
      const start = parseIsoDate(startIso)
      const end = parseIsoDate(endIso)
      if (!start || !end) return []
      const named = title && title !== 'missing value' ? title : '(No title)'
      return [{ title: named, start, end, calendar, allDay: allDay === 'true' }]
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime())
}

export function formatEvent(ev: CalendarEvent, now: Date): string {
  const when = ev.allDay ? 'All day' : timeRangeLabel(ev.start, ev.end)
  return `${relativeDay(ev.start, now)} · ${when} · ${ev.title} (${ev.calendar})`
}

const MAX_LISTED = 40

export const calendarListEvents = defineTool({
  name: 'calendar_list_events',
  description:
    "List events from the user's Calendar app. Pass range ('today', 'tomorrow' or 'week' = the next 7 days), " +
    'or start_iso (+ optional end_iso) for a custom window. Recurring events only show their first occurrence.',
  schema: {
    range: z.enum(['today', 'tomorrow', 'week']).optional(),
    start_iso: isoString.optional(),
    end_iso: isoString.optional()
  },
  risk: 'read',
  stepLabel: () => 'Checking your calendar',
  async run(args) {
    const now = new Date()
    const range = resolveRange(args, now)
    if (typeof range === 'string') return fail(range)
    const events = parseEvents(await runAppleScript(listEventsScript(range), { app: 'Calendar', timeoutMs: 30_000 }))
    if (!events.length) {
      const title = `No events ${range.phrase}`
      return { ok: true, text: `${title}.`, title, subtitle: 'Your calendar is clear' }
    }
    const next = events.find((ev) => ev.end > now) ?? events[0]
    const lines = events.slice(0, MAX_LISTED).map((ev) => formatEvent(ev, now))
    if (events.length > MAX_LISTED) lines.push(`…and ${events.length - MAX_LISTED} more`)
    return {
      ok: true,
      text: `${plural(events.length, 'event')} ${range.phrase}:\n${lines.join('\n')}`,
      title: `${plural(events.length, 'event')} ${range.phrase}`,
      subtitle: truncate(`${next.title} · ${next.allDay ? 'All day' : clockTime(next.start)}`, 60)
    }
  }
})

// ---------------------------------------------------------------------------
// Creating

export interface NewEvent {
  title: string
  start: Date
  end: Date
  attendees: string[]
  notes: string
  videoLink?: string
  /** Preferred calendar (Calendar's default); falls back to the first writable one. */
  calendarId?: string
}

/**
 * Creates the event, adds each attendee (one failing attendee doesn't undo the
 * event), then reads the saved event back so the card reports what Calendar
 * actually stored.
 */
export function createEventScript(ev: NewEvent): string {
  const description = [ev.notes.trim(), ev.videoLink ? `Join: ${ev.videoLink}` : ''].filter(Boolean).join('\n\n')
  const props = [`summary:${q(ev.title)}`, 'start date:startDate', 'end date:endDate', `description:${q(description)}`]
  if (ev.videoLink) props.push(`url:${q(ev.videoLink)}`)

  const lines = [
    MAKE_DATE_HANDLER,
    AS_SEPARATORS,
    `set startDate to ${appleScriptDate(ev.start)}`,
    `set endDate to ${appleScriptDate(ev.end)}`,
    'tell application "Calendar"',
    '\tset targetCal to missing value'
  ]
  if (ev.calendarId) {
    lines.push(
      '\ttry',
      `\t\tset targetCal to first calendar whose calendarIdentifier is ${q(ev.calendarId)} and writable is true`,
      '\tend try'
    )
  }
  lines.push(
    '\tif targetCal is missing value then',
    '\t\tset writableCals to calendars whose writable is true',
    '\t\tif writableCals is {} then error "There’s no calendar you can add events to." number 9001',
    '\t\tset targetCal to item 1 of writableCals',
    '\tend if',
    `\tset ev to make new event at end of events of targetCal with properties {${props.join(', ')}}`
  )
  for (const email of ev.attendees) {
    lines.push('\ttry', `\t\tmake new attendee at end of attendees of ev with properties {email:${q(email)}}`, '\tend try')
  }
  lines.push(
    `\treturn (summary of ev) & US & ${appleScriptIso('start date of ev')} & US & ${appleScriptIso('end date of ev')} & US & ((count of attendees of ev) as text) & US & (name of targetCal)`,
    'end tell'
  )
  return lines.join('\n')
}

export interface CreatedEvent {
  title: string
  start: Date
  end: Date
  guests: number
  calendar: string
}

export function parseCreatedEvent(output: string): CreatedEvent | null {
  const [fields] = splitRecords(output)
  if (!fields) return null
  const [title = '', startIso = '', endIso = '', guests = '0', calendar = ''] = fields
  const start = parseIsoDate(startIso)
  const end = parseIsoDate(endIso)
  if (!start || !end) return null
  return { title, start, end, guests: Number(guests) || 0, calendar }
}

/** "Tomorrow at 10:00 AM with 4 guests". */
export function createdSubtitle(ev: CreatedEvent, now: Date): string {
  const guests = guestsLabel(ev.guests)
  return `${relativeDay(ev.start, now)} at ${clockTime(ev.start)}${guests ? ` with ${guests}` : ''}`
}

interface CreateArgs {
  title: string
  start_iso: string
  end_iso: string
  attendees: string[]
  video_link?: string
}

export function eventConfirmDetails(args: CreateArgs, now: Date): ConfirmDetails {
  const start = parseIsoDate(args.start_iso)
  const end = parseIsoDate(args.end_iso)
  return {
    kind: 'event',
    title: args.title,
    dateLabel: start ? dateLabel(start, now) : args.start_iso,
    timeLabel: start && end ? timeRangeLabel(start, end) : '',
    guestsLabel: guestsLabel(args.attendees.length),
    videoLabel: videoLabel(args.video_link)
  }
}

export const calendarCreateEvent = defineTool({
  name: 'calendar_create_event',
  description:
    "Create an event in the user's default Calendar calendar and invite attendees by email. " +
    'Times are ISO 8601; without an offset they are the local time zone.',
  schema: {
    title: z.string().trim().min(1),
    start_iso: isoString,
    end_iso: isoString,
    attendees: z.array(z.string().trim().email()).default([]).describe('Attendee email addresses'),
    notes: z.string().default(''),
    video_link: z.string().url().optional().describe('Google Meet / Zoom / other meeting URL')
  },
  risk: 'write',
  stepLabel: (args) => (args.attendees.length ? 'Creating event and inviting guests' : 'Creating event'),
  confirmDetails: (args) => eventConfirmDetails(args, new Date()),
  async run(args) {
    const start = parseIsoDate(args.start_iso)
    const end = parseIsoDate(args.end_iso)
    if (!start || !end) return fail('Use ISO 8601 dates, e.g. 2026-10-25T10:00:00')
    if (end <= start) return fail('end_iso must be after start_iso')

    const calendarId = (await readDefault('com.apple.iCal', 'defaultCalendarID')) ?? undefined
    const script = createEventScript({
      title: args.title,
      start,
      end,
      attendees: args.attendees,
      notes: args.notes,
      videoLink: args.video_link,
      calendarId
    })
    const created = parseCreatedEvent(await runAppleScript(script, { app: 'Calendar', timeoutMs: 30_000 }))
    if (!created) return fail('Calendar did not confirm the new event')

    const now = new Date()
    const missing = args.attendees.length - created.guests
    const guestNote =
      missing > 0
        ? ` Only ${created.guests} of ${args.attendees.length} guests were added; ` +
          `the "${created.calendar}" calendar may not support invitations.`
        : ''
    return {
      ok: true,
      text:
        `Created "${created.title}" in ${created.calendar}: ${dateLabel(created.start, now)}, ` +
        `${timeRangeLabel(created.start, created.end)}, ${plural(created.guests, 'guest')}.${guestNote}`,
      title: created.guests > 0 || args.video_link ? 'Meeting created' : 'Event created',
      subtitle: createdSubtitle(created, now),
      view: { kind: 'openApp', app: 'Calendar' }
    }
  }
})
