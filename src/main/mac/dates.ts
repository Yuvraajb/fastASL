/** Local wall-clock fields of a date, as AppleScript wants them (month is 1-12). */
export interface DateParts {
  year: number
  month: number
  day: number
  hours: number
  minutes: number
  seconds: number
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i

/**
 * Parses an ISO 8601 date or date-time. A date-only value or a date-time
 * without an offset is local time; impossible dates (Feb 30) are rejected
 * instead of rolling over.
 */
export function parseIsoDate(iso: string): Date | null {
  const m = ISO.exec(iso.trim())
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0', offset] = m
  const fields = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number]
  const [year, month, day, hours, minutes, seconds] = fields
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  if (hours > 23 || minutes > 59 || seconds > 59) return null

  if (!offset) return new Date(year, month - 1, day, hours, minutes, seconds)
  const sign = offset.toUpperCase() === 'Z' ? 1 : offset.startsWith('-') ? -1 : 1
  const offsetMinutes = offset.toUpperCase() === 'Z' ? 0 : Number(offset.slice(1, 3)) * 60 + Number(offset.slice(-2))
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds) - sign * offsetMinutes * 60_000)
}

export function isIsoDate(iso: string): boolean {
  return parseIsoDate(iso) !== null
}

export function toDateParts(date: Date): DateParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds()
  }
}

/**
 * AppleScript handler that builds a date from numbers, so nothing depends on
 * the user's locale date format. The day is reset to 1 first so changing the
 * month never overflows (Jan 31 -> "Feb 31" -> Mar 3).
 */
export const MAKE_DATE_HANDLER = `on makeDate(y, mo, d, h, mi, s)
\tset dt to current date
\tset day of dt to 1
\tset year of dt to y
\tset month of dt to mo
\tset day of dt to d
\tset hours of dt to h
\tset minutes of dt to mi
\tset seconds of dt to s
\treturn dt
end makeDate`

/** Expression calling MAKE_DATE_HANDLER for the given local date. */
export function appleScriptDate(date: Date): string {
  const p = toDateParts(date)
  return `my makeDate(${p.year}, ${p.month}, ${p.day}, ${p.hours}, ${p.minutes}, ${p.seconds})`
}

/** AppleScript expression turning a date expression into "YYYY-MM-DDTHH:MM:SS" (local). */
export function appleScriptIso(dateExpr: string): string {
  return `((${dateExpr}) as «class isot» as string)`
}
