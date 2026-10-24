// Human-readable labels for cards. Formatting is done by hand (en-US) so the
// output never depends on the ICU build (e.g. U+202F before "AM").

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** Calendar days from `now` to `date` (0 = same day), DST-safe. */
export function dayOffset(date: Date, now: Date): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000)
}

/** "Oct 25", or "Oct 25, 2027" outside the current year. */
function monthDay(date: Date, now: Date): string {
  const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`
  return date.getFullYear() === now.getFullYear() ? base : `${base}, ${date.getFullYear()}`
}

/** "Today" / "Tomorrow" / "Yesterday" / "Friday, Oct 30". */
export function relativeDay(date: Date, now: Date): string {
  const offset = dayOffset(date, now)
  if (offset === 0) return 'Today'
  if (offset === 1) return 'Tomorrow'
  if (offset === -1) return 'Yesterday'
  return `${WEEKDAYS[date.getDay()]}, ${monthDay(date, now)}`
}

/** "Today, Oct 24" / "Tomorrow, Oct 25" / "Friday, Oct 30". */
export function dateLabel(date: Date, now: Date): string {
  const offset = dayOffset(date, now)
  return Math.abs(offset) <= 1 ? `${relativeDay(date, now)}, ${monthDay(date, now)}` : relativeDay(date, now)
}

function clock(date: Date): { time: string; meridiem: 'AM' | 'PM' } {
  const h = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return { time: `${h % 12 || 12}:${minutes}`, meridiem: h < 12 ? 'AM' : 'PM' }
}

/** "10:00 AM". */
export function clockTime(date: Date): string {
  const { time, meridiem } = clock(date)
  return `${time} ${meridiem}`
}

/** "10:00 – 11:00 AM", or "11:30 AM – 12:30 PM" when the halves differ. */
export function timeRangeLabel(start: Date, end: Date): string {
  const a = clock(start)
  const b = clock(end)
  return a.meridiem === b.meridiem
    ? `${a.time} – ${b.time} ${b.meridiem}`
    : `${a.time} ${a.meridiem} – ${b.time} ${b.meridiem}`
}

export function guestsLabel(count: number): string | undefined {
  if (count <= 0) return undefined
  return count === 1 ? '1 guest' : `${count} guests`
}

const VIDEO_HOSTS: [RegExp, string][] = [
  [/(^|\.)meet\.google\.com$/, 'Google Meet'],
  [/(^|\.)zoom\.(us|com)$|(^|\.)zoomgov\.com$/, 'Zoom'],
  [/(^|\.)teams\.(microsoft|live)\.com$/, 'Microsoft Teams'],
  [/(^|\.)facetime\.apple\.com$/, 'FaceTime'],
  [/(^|\.)webex\.com$/, 'Webex']
]

/** Names the video service from the link's host; unknown hosts are "Video link". */
export function videoLabel(link?: string): string | undefined {
  if (!link) return undefined
  try {
    const host = new URL(link).hostname.toLowerCase()
    return VIDEO_HOSTS.find(([re]) => re.test(host))?.[1] ?? 'Video link'
  } catch {
    return 'Video link'
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
