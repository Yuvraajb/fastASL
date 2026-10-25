import { runAppleScript } from './osascript'

/**
 * Presses Call in FaceTime. A facetime:// link only opens FaceTime on "Click to call" (+1 ...,
 * Cancel / Call), and the user already confirmed the call on fastASL's card, so it is pressed
 * here: the button whose accessibility description is "Call", found within about 6 s. Needs
 * Accessibility access for fastASL (System Settings › Privacy & Security › Accessibility).
 */
export const PRESS_CALL_SCRIPT = pressButtonScript('Call')

/**
 * Finds FaceTime's button with this accessibility description and presses it. Windows are
 * addressed by index: "entire contents of" an item from "repeat with w in windows" fails ("Can't
 * make item 1 of entire contents ... into type specifier"), which left Call unpressed live. A window
 * that changes while it is read is skipped and tried again on the next pass.
 */
export function pressButtonScript(description: string): string {
  return `tell application "System Events"
  repeat 20 times
    if exists process "FaceTime" then
      tell process "FaceTime"
        repeat with i from 1 to (count of windows)
          try
            set els to entire contents of window i
            repeat with e in els
              set el to contents of e
              try
                if (role of el) is "AXButton" and (description of el) is "${description}" then
                  perform action "AXPress" of el
                  return "pressed"
                end if
              end try
            end repeat
          end try
        end repeat
      end tell
    end if
    delay 0.3
  end repeat
end tell
return "not found"`
}

/** Whether Call was pressed; an error (no Accessibility access) says why it wasn't. */
export async function pressFaceTimeCall(): Promise<{ pressed: boolean; error?: string }> {
  try {
    const out = await runAppleScript(PRESS_CALL_SCRIPT, { timeoutMs: 15_000, app: 'FaceTime' })
    return { pressed: out.trim() === 'pressed' }
  } catch (error) {
    return { pressed: false, error: error instanceof Error ? error.message : String(error) }
  }
}
