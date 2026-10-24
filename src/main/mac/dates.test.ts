import { describe, expect, it } from 'vitest'
import { MAKE_DATE_HANDLER, appleScriptDate, appleScriptIso, isIsoDate, parseIsoDate, toDateParts } from './dates'
import { runAppleScript } from './osascript'

describe('parseIsoDate', () => {
  it('reads a date-time without offset as local wall-clock time', () => {
    expect(parseIsoDate('2026-10-25T10:30:00')).toEqual(new Date(2026, 9, 25, 10, 30, 0))
    expect(parseIsoDate('2026-10-25T10:30')).toEqual(new Date(2026, 9, 25, 10, 30))
    expect(parseIsoDate('2026-10-25 10:30')).toEqual(new Date(2026, 9, 25, 10, 30))
  })

  it('reads a date-only value as local midnight (not UTC)', () => {
    expect(parseIsoDate('2026-10-25')).toEqual(new Date(2026, 9, 25))
  })

  it('honours Z and numeric offsets', () => {
    expect(parseIsoDate('2026-10-25T10:00:00Z')?.toISOString()).toBe('2026-10-25T10:00:00.000Z')
    expect(parseIsoDate('2026-10-25T10:00:00+05:30')?.toISOString()).toBe('2026-10-25T04:30:00.000Z')
    expect(parseIsoDate('2026-10-25T10:00:00-0700')?.toISOString()).toBe('2026-10-25T17:00:00.000Z')
    expect(parseIsoDate('2026-10-25T10:00:00.123Z')?.toISOString()).toBe('2026-10-25T10:00:00.000Z')
  })

  it('rejects impossible or malformed dates instead of rolling over', () => {
    for (const bad of ['2026-02-30T10:00', '2026-13-01', '2026-10-25T24:00', '2026-10-25T10:60', 'tomorrow', '', '25/10/2026']) {
      expect(parseIsoDate(bad), bad).toBeNull()
      expect(isIsoDate(bad)).toBe(false)
    }
    expect(parseIsoDate('2028-02-29')).toEqual(new Date(2028, 1, 29))
  })
})

describe('AppleScript date pieces', () => {
  it('splits a date into local fields with a 1-based month', () => {
    expect(toDateParts(new Date(2026, 0, 31, 9, 5, 7))).toEqual({
      year: 2026,
      month: 1,
      day: 31,
      hours: 9,
      minutes: 5,
      seconds: 7
    })
  })

  it('builds a makeDate call from numbers only', () => {
    expect(appleScriptDate(new Date(2026, 9, 25, 10, 0, 0))).toBe('my makeDate(2026, 10, 25, 10, 0, 0)')
    expect(appleScriptIso('start date of ev')).toBe('((start date of ev) as «class isot» as string)')
  })

  it('resets the day before the month so dates never overflow', () => {
    const lines = MAKE_DATE_HANDLER.split('\n').map((l) => l.trim())
    expect(lines.indexOf('set day of dt to 1')).toBeLessThan(lines.indexOf('set month of dt to mo'))
  })

  it.runIf(process.platform === 'darwin')('round-trips through real AppleScript', async () => {
    for (const date of [new Date(2026, 9, 25, 10, 0, 0), new Date(2028, 1, 29, 23, 59, 59), new Date(2027, 11, 31, 0, 0, 0)]) {
      const iso = await runAppleScript(`${MAKE_DATE_HANDLER}\nreturn ${appleScriptIso(appleScriptDate(date))}`)
      expect(parseIsoDate(iso)).toEqual(date)
    }
  })
})
