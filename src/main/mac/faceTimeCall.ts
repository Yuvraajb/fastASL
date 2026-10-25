import { runAppleScript } from './osascript'

/**
 * Presses Call in FaceTime. A facetime:// link only opens FaceTime on "Click to call" (+1 ...,
 * Cancel / Call), and the user already confirmed the call on fastASL's card, so it is pressed
 * here: the button whose accessibility description is "Call", found within about 6 s. Needs
 * Accessibility access for fastASL (System Settings › Privacy & Security › Accessibility).
 */
export const PRESS_CALL_SCRIPT = `tell application "System Events"
  repeat 20 times
    if exists process "FaceTime" then
      tell process "FaceTime"
        repeat with w in windows
          repeat with e in (entire contents of w)
            set el to contents of e
            try
              if (role of el) is "AXButton" and (description of el) is "Call" then
                perform action "AXPress" of el
                return "pressed"
              end if
            end try
          end repeat
        end repeat
      end tell
    end if
    delay 0.3
  end repeat
end tell
return "not found"`

/** Whether Call was pressed; an error (no Accessibility access) says why it wasn't. */
export async function pressFaceTimeCall(): Promise<{ pressed: boolean; error?: string }> {
  try {
    const out = await runAppleScript(PRESS_CALL_SCRIPT, { timeoutMs: 15_000, app: 'FaceTime' })
    return { pressed: out.trim() === 'pressed' }
  } catch (error) {
    return { pressed: false, error: error instanceof Error ? error.message : String(error) }
  }
}
