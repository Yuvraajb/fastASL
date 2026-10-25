import { describe, expect, it } from 'vitest'
import { describeNow, SYSTEM_PROMPT, turnPrompt } from './prompt'

const now = new Date('2026-10-24T22:45:00Z')

describe('turn prompt', () => {
  it('states local date, time, time zone and UTC offset', () => {
    expect(describeNow(now, 'America/Los_Angeles')).toBe(
      'Saturday, October 24, 2026 at 3:45 PM (2026-10-24 15:45, America/Los_Angeles, GMT-07:00)'
    )
    expect(describeNow(now, 'Asia/Tokyo')).toContain('Sunday, October 25, 2026')
  })

  it('includes the frontmost app, the signed sentence and the task', () => {
    const prompt = turnPrompt(
      { intent: 'Email Sam the slides', sentence: 'EMAIL SAM SLIDES', frontmost: { name: 'Keynote', windowTitle: 'Q4.key' } },
      now,
      'UTC'
    )
    expect(prompt.split('\n')).toEqual([
      'Current date and time: Saturday, October 24, 2026 at 10:45 PM (2026-10-24 22:45, UTC, GMT)',
      'Frontmost app: Keynote (window: "Q4.key")',
      'Signed sentence: "EMAIL SAM SLIDES"',
      'Message: Email Sam the slides'
    ])
  })
})

describe('system prompt', () => {
  it('answers conversational messages in one or two sentences, with no tools', () => {
    expect(SYSTEM_PROMPT).toMatch(/greetings, thanks, small talk, questions about you, or about the current date or time/)
    expect(SYSTEM_PROMPT).toMatch(/one or two plain-English sentences, and NO tool calls/)
    expect(SYSTEM_PROMPT).toMatch(/one ongoing conversation/)
  })

  it('keeps every safety rule', () => {
    for (const rule of [
      'Use ONLY the tools from the "fastasl" MCP server',
      'Never read or edit files, run shell commands, browse the web, or use any other tool',
      'the user reviews every send, create or delete on a confirmation card before it runs',
      'call contacts_find and pass the exact full name it returns',
      'Never claim something happened unless a tool result says so',
      'If a tool fails or is cancelled, stop'
    ]) {
      expect(SYSTEM_PROMPT).toContain(rule)
    }
  })
})
