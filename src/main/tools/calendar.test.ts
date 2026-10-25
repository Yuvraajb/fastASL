import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDefault } from '../mac/exec'
import { SEP, runAppleScript } from '../mac/osascript'
import {
  calendarCreateEvent,
  createEventScript,
  createdSubtitle,
  eventConfirmDetails,
  formatEvent,
  listEventsScript,
  parseCreatedEvent,
  parseEvents,
  resolveRange
} from './calendar'

vi.mock('../mac/osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/osascript')>()),
  runAppleScript: vi.fn()
}))
vi.mock('../mac/exec', () => ({ readDefault: vi.fn(async () => null), exec: vi.fn() }))

const runMock = vi.mocked(runAppleScript)
const record = (...fields: string[]): string => fields.join(SEP.field)

// Saturday Oct 24, 2026, 2:15 PM local.
const now = new Date(2026, 9, 24, 14, 15)

describe('resolveRange', () => {
  it('maps named ranges to local day boundaries', () => {
    expect(resolveRange({}, now)).toEqual({ start: new Date(2026, 9, 24), end: new Date(2026, 9, 25), phrase: 'today' })
    expect(resolveRange({ range: 'tomorrow' }, now)).toEqual({
      start: new Date(2026, 9, 25),
      end: new Date(2026, 9, 26),
      phrase: 'tomorrow'
    })
    expect(resolveRange({ range: 'week' }, now)).toEqual({
      start: new Date(2026, 9, 24),
      end: new Date(2026, 9, 31),
      phrase: 'in the next 7 days'
    })
  })

  it('accepts a custom window and phrases it', () => {
    expect(resolveRange({ start_iso: '2026-10-30' }, now)).toMatchObject({ phrase: 'on Friday, Oct 30' })
    expect(resolveRange({ start_iso: '2026-10-25T00:00', end_iso: '2026-10-25T12:00' }, now)).toMatchObject({
      phrase: 'tomorrow'
    })
    expect(resolveRange({ start_iso: '2026-10-26', end_iso: '2026-10-29' }, now)).toMatchObject({
      phrase: 'from Monday, Oct 26 to Wednesday, Oct 28'
    })
  })

  it('rejects an end before the start', () => {
    expect(resolveRange({ start_iso: '2026-10-26', end_iso: '2026-10-25' }, now)).toBe('end_iso must be after start_iso')
  })
})

describe('listing', () => {
  it('filters each calendar exactly once by overlap with locale-free dates and reads only the hits', () => {
    const script = listEventsScript({ start: new Date(2026, 9, 24), end: new Date(2026, 9, 25) })
    expect(script).toContain('set rangeStart to my makeDate(2026, 10, 24, 0, 0, 0)')
    expect(script).toContain('set rangeEnd to my makeDate(2026, 10, 25, 0, 0, 0)')
    // Resolved to a list once: a bulk read of a live `whose` reference re-runs the slow date filter per property.
    expect(script).toContain('set hits to (every event of cal whose start date < rangeEnd and end date > rangeStart)')
    expect(script.match(/whose/g)).toHaveLength(1)
    expect(script).not.toContain('tell (every event')
    expect(script).toContain('((start date of ev) as «class isot» as string)')
    expect(script).toContain('((end date of ev) as «class isot» as string)')
  })

  it('parses, names untitled events and sorts by start', () => {
    const out = [
      record('Lunch', '2026-10-24T12:00:00', '2026-10-24T13:00:00', 'Home', 'false'),
      record('missing value', '2026-10-24T09:00:00', '2026-10-24T09:30:00', 'Work', 'false'),
      record('Broken', 'garbage', '', 'Work', 'false'),
      record('Holiday', '2026-10-24T00:00:00', '2026-10-25T00:00:00', 'Holidays', 'true')
    ].join(SEP.record)
    const events = parseEvents(out)
    expect(events.map((e) => e.title)).toEqual(['Holiday', '(No title)', 'Lunch'])
    expect(events[0].allDay).toBe(true)
    expect(formatEvent(events[2], now)).toBe('Today · 12:00 – 1:00 PM · Lunch (Home)')
    expect(formatEvent(events[0], now)).toBe('Today · All day · Holiday (Holidays)')
  })
})

describe('createEventScript', () => {
  const base = {
    title: 'Design review',
    start: new Date(2026, 9, 25, 10, 0),
    end: new Date(2026, 9, 25, 11, 0),
    attendees: ['ana@example.com', 'bo@example.com'],
    notes: 'Bring mocks',
    videoLink: 'https://meet.google.com/abc-defg-hij'
  }

  it('produces the expected AppleScript', () => {
    const script = createEventScript(base)
    expect(script).toContain('set startDate to my makeDate(2026, 10, 25, 10, 0, 0)')
    expect(script).toContain('set endDate to my makeDate(2026, 10, 25, 11, 0, 0)')
    expect(script).toContain(
      'set ev to make new event at end of events of targetCal with properties {summary:"Design review", start date:startDate, end date:endDate, description:"Bring mocks\\n\\nJoin: https://meet.google.com/abc-defg-hij", url:"https://meet.google.com/abc-defg-hij"}'
    )
    expect(script).toContain('make new attendee at end of attendees of ev with properties {email:"ana@example.com"}')
    expect(script).toContain('make new attendee at end of attendees of ev with properties {email:"bo@example.com"}')
    expect(script).toContain('set writableCals to calendars whose writable is true')
    expect(script).toContain('((count of attendees of ev) as text)')
    expect(script).not.toContain('calendarIdentifier')
  })

  it('prefers the default calendar when its id is known', () => {
    const script = createEventScript({ ...base, calendarId: 'ABC-123' })
    expect(script).toContain('set targetCal to first calendar whose calendarIdentifier is "ABC-123" and writable is true')
  })

  it('falls back to a usually-default calendar name before the first writable calendar', () => {
    // macOS 26 can't read calendarIdentifier, and the first writable calendar was "Finished" on a real Mac.
    const script = createEventScript({ ...base, calendarId: 'ABC-123' })
    const first = script.indexOf('set targetCal to item 1 of writableCals')
    const preferred = script.indexOf('repeat with preferred in {"Calendar", "Home", "Personal", "Work"}')
    expect(first).toBeGreaterThan(-1)
    expect(preferred).toBeGreaterThan(first)
    expect(script).toContain('set nameHits to (calendars whose writable is true and name is (preferred as text))')
  })

  it('omits url and attendees when not given', () => {
    const script = createEventScript({ ...base, attendees: [], videoLink: undefined, notes: '' })
    expect(script).not.toContain('url:')
    expect(script).not.toContain('make new attendee')
    expect(script).toContain('description:""')
  })

  it('escapes every user string', () => {
    const script = createEventScript({ ...base, title: 'Q4 "plan"\n" & (do shell script "x") & "', notes: 'a\\b' })
    expect(script).toContain('summary:"Q4 \\"plan\\"\\n\\" & (do shell script \\"x\\") & \\""')
    expect(script).toContain('description:"a\\\\b')
  })
})

describe('read-back and labels', () => {
  it('parses the created event', () => {
    expect(parseCreatedEvent(record('Sync', '2026-10-25T10:00:00', '2026-10-25T11:00:00', '4', 'Work'))).toEqual({
      title: 'Sync',
      start: new Date(2026, 9, 25, 10),
      end: new Date(2026, 9, 25, 11),
      guests: 4,
      calendar: 'Work'
    })
    expect(parseCreatedEvent('')).toBeNull()
  })

  it('writes the Done subtitle from the stored event', () => {
    const ev = { title: 'Sync', start: new Date(2026, 9, 25, 10), end: new Date(2026, 9, 25, 11), guests: 4, calendar: 'Work' }
    expect(createdSubtitle(ev, now)).toBe('Tomorrow at 10:00 AM with 4 guests')
    expect(createdSubtitle({ ...ev, guests: 1 }, now)).toBe('Tomorrow at 10:00 AM with 1 guest')
    expect(createdSubtitle({ ...ev, guests: 0, start: new Date(2026, 9, 30, 15, 30) }, now)).toBe('Friday, Oct 30 at 3:30 PM')
  })

  it('builds the confirm card', () => {
    expect(
      eventConfirmDetails(
        {
          title: 'Design review',
          start_iso: '2026-10-25T10:00:00',
          end_iso: '2026-10-25T11:00:00',
          attendees: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'],
          video_link: 'https://meet.google.com/abc'
        },
        now
      )
    ).toEqual({
      kind: 'event',
      title: 'Design review',
      dateLabel: 'Tomorrow, Oct 25',
      timeLabel: '10:00 – 11:00 AM',
      guestsLabel: '4 guests',
      videoLabel: 'Google Meet'
    })
  })
})

describe('calendar_create_event run', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now, toFake: ['Date'] })
    runMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const args = {
    title: 'Design review',
    start_iso: '2026-10-25T10:00:00',
    end_iso: '2026-10-25T11:00:00',
    attendees: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'],
    notes: ''
  }

  it('reports what Calendar actually stored', async () => {
    runMock.mockResolvedValue(record('Design review', '2026-10-25T10:00:00', '2026-10-25T11:00:00', '4', 'Work'))
    const outcome = await calendarCreateEvent.run(args)
    expect(outcome).toMatchObject({
      ok: true,
      title: 'Meeting created',
      subtitle: 'Tomorrow at 10:00 AM with 4 guests',
      view: { kind: 'openApp', app: 'Calendar' }
    })
    expect(vi.mocked(readDefault)).toHaveBeenCalledWith('com.apple.iCal', 'defaultCalendarID')
    expect(runMock.mock.calls[0][1]).toMatchObject({ app: 'Calendar', launch: true })
  })

  it('says so when Calendar dropped some guests', async () => {
    runMock.mockResolvedValue(record('Design review', '2026-10-25T10:00:00', '2026-10-25T11:00:00', '0', 'On My Mac'))
    const outcome = await calendarCreateEvent.run(args)
    expect(outcome.title).toBe('Event created')
    expect(outcome.subtitle).toBe('Tomorrow at 10:00 AM')
    expect(outcome.text).toContain('Only 0 of 4 guests were added')
  })

  it('refuses an end before the start without running a script', async () => {
    const outcome = await calendarCreateEvent.run({ ...args, end_iso: '2026-10-25T09:00:00' })
    expect(outcome).toEqual({ ok: false, text: 'end_iso must be after start_iso' })
    expect(runMock).not.toHaveBeenCalled()
  })
})
