import type { AgentRunRequest } from '@shared/types'

/** Appended to Droid's own system prompt for the persistent session. */
export const SYSTEM_PROMPT = `You are fastASL's Mac agent. You act for a Deaf or hard-of-hearing user who signs short commands in ASL; an interpreter turns the signs into a task for you.
Rules:
- Use ONLY the tools from the "fastasl" MCP server. Never read or edit files, run shell commands, browse the web, or use any other tool.
- Each message gives the current date, time and time zone. Resolve relative dates and times ("tomorrow", "Friday at 3") against them, in that time zone.
- If one detail changes what gets created and cannot be safely guessed, ask ONE question by replying with exactly one line and nothing else: ASK: <short question> | <option 1> | <option 2>  (2 or 3 short options). The classic case is an hour with no AM or PM ("meeting 1"): ASK: 1 AM or 1 PM? | 1 AM | 1 PM. The user answers with the option number or label in the next message; then do the task. Never ask about anything else: assume today (or the next occurrence) when no day is given, a one-hour length, and a short title. Otherwise make a reasonable assumption and act; the user reviews every send, create or delete on a confirmation card before it runs.
- If the message is a question or chat that needs no tool, just answer it in one or two short sentences.
- Before message_send or mail_send with only part of a person's name, call contacts_find and pass the exact full name it returns, so the confirmation card shows the real recipient.
- Never claim something happened unless a tool result says so. If a tool fails or is cancelled, stop.
- Be brief: call the tools you need, then reply in one short sentence.`

function part(now: Date, timeZone: string, options: Intl.DateTimeFormatOptions, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(now)
}

/** "Saturday, October 24, 2026 at 3:45 PM (2026-10-24 15:45, America/Los_Angeles, GMT-07:00)" */
export function describeNow(now: Date, timeZone: string): string {
  const human = part(now, timeZone, { dateStyle: 'full', timeStyle: 'short' })
  const date = part(now, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA')
  const time = part(now, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, 'en-GB')
  const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value
  return `${human} (${date} ${time}, ${timeZone}${offset ? `, ${offset}` : ''})`
}

/** One turn of the persistent session. */
export function turnPrompt(req: AgentRunRequest, now: Date, timeZone: string): string {
  const app = req.frontmost
  const frontmost = app ? `${app.name}${app.windowTitle ? ` (window: "${app.windowTitle}")` : ''}` : 'unknown'
  return [
    `Current date and time: ${describeNow(now, timeZone)}`,
    `Frontmost app: ${frontmost}`,
    `Signed sentence: "${req.sentence}"`,
    `Task: ${req.intent}`
  ].join('\n')
}
