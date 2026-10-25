import { runJxa } from './osascript'

/**
 * JXA that brings Mail and Calendar forward on the left half of the main screen: Mail in the top
 * quarter, Calendar below it showing the day of `day` (the fastASL overlay sits on the right).
 * Each app is placed on its own; one that has no window or refuses is skipped. Prints
 * {"mail":bool,"calendar":bool}.
 */
export function arrangeScript(day: Date): string {
  return `ObjC.import('AppKit')
const screen = $.NSScreen.mainScreen
const full = screen.frame
const vis = screen.visibleFrame
const top = full.size.height - (vis.origin.y + vis.size.height)
const W = Math.round(vis.size.width / 2)
const H = Math.round(vis.size.height / 2)
function place(name, row, prepare) {
  try {
    const app = Application(name)
    app.activate()
    if (prepare) prepare(app)
    for (let i = 0; i < 20 && app.windows.length === 0; i++) delay(0.25)
    if (app.windows.length === 0) return false
    app.windows[0].bounds = { x: Math.round(vis.origin.x), y: Math.round(top + row * H), width: W, height: H }
    return true
  } catch (e) {
    return false
  }
}
const mail = place('Mail', 0)
const calendar = place('Calendar', 1, (app) => {
  try {
    app.switchView({ to: 'day view' })
    app.viewCalendar({ at: new Date(${day.getTime()}) })
  } catch (e) {}
})
JSON.stringify({ mail: mail, calendar: calendar })`
}

/** Mail top left, Calendar (on that day) bottom left. Never throws: placement is only for show. */
export async function arrangeMailAndCalendar(day: Date): Promise<{ mail: boolean; calendar: boolean }> {
  try {
    const out = await runJxa(arrangeScript(day), { timeoutMs: 20_000 })
    const parsed = JSON.parse(out) as { mail?: unknown; calendar?: unknown }
    return { mail: parsed.mail === true, calendar: parsed.calendar === true }
  } catch {
    return { mail: false, calendar: false }
  }
}
