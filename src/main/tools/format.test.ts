import { describe, expect, it } from 'vitest'
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

// Saturday Oct 24, 2026, 2:15 PM local.
const now = new Date(2026, 9, 24, 14, 15)

describe('relative days', () => {
  it('counts calendar days, not 24h periods', () => {
    expect(dayOffset(new Date(2026, 9, 25, 0, 5), now)).toBe(1)
    expect(dayOffset(new Date(2026, 9, 24, 23, 59), now)).toBe(0)
    expect(dayOffset(new Date(2026, 10, 2, 9), now)).toBe(9) // across the DST change on Nov 1
  })

  it('labels today, tomorrow and other days', () => {
    expect(relativeDay(new Date(2026, 9, 24, 18), now)).toBe('Today')
    expect(relativeDay(new Date(2026, 9, 25, 10), now)).toBe('Tomorrow')
    expect(relativeDay(new Date(2026, 9, 23, 10), now)).toBe('Yesterday')
    expect(relativeDay(new Date(2026, 9, 30, 10), now)).toBe('Friday, Oct 30')
    expect(relativeDay(new Date(2027, 0, 8, 10), now)).toBe('Friday, Jan 8, 2027')
  })

  it('adds the date to Today / Tomorrow on the confirm card', () => {
    expect(dateLabel(new Date(2026, 9, 24, 18), now)).toBe('Today, Oct 24')
    expect(dateLabel(new Date(2026, 9, 25, 10), now)).toBe('Tomorrow, Oct 25')
    expect(dateLabel(new Date(2026, 9, 27, 10), now)).toBe('Tuesday, Oct 27')
  })
})

describe('times', () => {
  it('formats 12-hour clock times', () => {
    expect(clockTime(new Date(2026, 9, 25, 0, 0))).toBe('12:00 AM')
    expect(clockTime(new Date(2026, 9, 25, 12, 5))).toBe('12:05 PM')
    expect(clockTime(new Date(2026, 9, 25, 9, 30))).toBe('9:30 AM')
  })

  it('shares the meridiem when both ends agree', () => {
    expect(timeRangeLabel(new Date(2026, 9, 25, 10), new Date(2026, 9, 25, 11))).toBe('10:00 – 11:00 AM')
    expect(timeRangeLabel(new Date(2026, 9, 25, 11, 30), new Date(2026, 9, 25, 12, 30))).toBe('11:30 AM – 12:30 PM')
    expect(timeRangeLabel(new Date(2026, 9, 25, 22), new Date(2026, 9, 26, 1))).toBe('10:00 PM – 1:00 AM')
  })
})

describe('guests and video', () => {
  it('pluralizes guests and hides zero', () => {
    expect(guestsLabel(0)).toBeUndefined()
    expect(guestsLabel(1)).toBe('1 guest')
    expect(guestsLabel(4)).toBe('4 guests')
  })

  it('names the video service from the link host', () => {
    expect(videoLabel('https://meet.google.com/abc-defg-hij')).toBe('Google Meet')
    expect(videoLabel('https://us02web.zoom.us/j/123')).toBe('Zoom')
    expect(videoLabel('https://teams.microsoft.com/l/meetup-join/x')).toBe('Microsoft Teams')
    expect(videoLabel('https://facetime.apple.com/join#v=1')).toBe('FaceTime')
    expect(videoLabel('https://example.com/room')).toBe('Video link')
    expect(videoLabel('https://notzoom.us.evil.com/x')).toBe('Video link')
    expect(videoLabel('not a url')).toBe('Video link')
    expect(videoLabel(undefined)).toBeUndefined()
  })
})

describe('text helpers', () => {
  it('truncates with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('a long sentence here', 8)).toBe('a long…')
  })

  it('pluralizes', () => {
    expect(plural(1, 'event')).toBe('1 event')
    expect(plural(3, 'event')).toBe('3 events')
  })
})
