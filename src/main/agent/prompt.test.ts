import { describe, expect, it } from 'vitest'
import { describeNow, turnPrompt } from './prompt'

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
      'Task: Email Sam the slides'
    ])
  })
})
