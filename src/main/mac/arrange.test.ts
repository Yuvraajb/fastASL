import { describe, expect, it } from 'vitest'
import { arrangeScript } from './arrange'

describe('arrangeScript', () => {
  it('puts Mail in the top left quarter and Calendar below it, on the meeting day', () => {
    const day = new Date(2026, 9, 25, 14)
    const script = arrangeScript(day)
    expect(script).toContain("place('Mail', 0)")
    expect(script).toContain("place('Calendar', 1,")
    expect(script).toContain(`new Date(${day.getTime()})`)
    expect(script).toContain("switchView({ to: 'day view' })")
    expect(script).toContain('vis.size.width / 2')
  })
})
