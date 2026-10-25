import { describe, expect, it } from 'vitest'
import { PRESS_CALL_SCRIPT, pressButtonScript } from './faceTimeCall'

describe('pressButtonScript', () => {
  it('presses the FaceTime button with that description, addressing windows by index', () => {
    expect(PRESS_CALL_SCRIPT).toBe(pressButtonScript('Call'))
    expect(PRESS_CALL_SCRIPT).toContain('(description of el) is "Call"')
    expect(PRESS_CALL_SCRIPT).toContain('entire contents of window i')
    // The form that failed live: entire contents of a "repeat with w in windows" item.
    expect(PRESS_CALL_SCRIPT).not.toContain('repeat with w in windows')
    expect(PRESS_CALL_SCRIPT).toContain('perform action "AXPress" of el')
  })
})
