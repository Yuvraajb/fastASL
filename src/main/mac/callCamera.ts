import { exec } from './exec'
import { runAppleScript } from './osascript'

/** The camera OBS publishes (its Virtual Camera), which shows the caption window to the person on the call. */
export const OBS_CAMERA = 'OBS Virtual Camera'

/** Clicks OBS's "Start Virtual Camera" button (the Controls dock) unless it already says Stop, and waits for it to say Stop. */
export const START_OBS_CAMERA_SCRIPT = `tell application "System Events"
\tif not (exists process "OBS") then return "not-running"
\ttell process "OBS"
\t\ttry
\t\t\tset stopButton to first button of window 1 whose name is "Stop Virtual Camera"
\t\t\treturn "already-on"
\t\tend try
\t\ttry
\t\t\tclick (first button of window 1 whose name is "Start Virtual Camera")
\t\t\trepeat 6 times
\t\t\t\tdelay 0.5
\t\t\t\ttry
\t\t\t\t\tset stopButton to first button of window 1 whose name is "Stop Virtual Camera"
\t\t\t\t\treturn "started"
\t\t\t\tend try
\t\t\tend repeat
\t\t\treturn "not-started"
\t\tend try
\t\treturn "no-button"
\tend tell
end tell`

/** Picks the camera in FaceTime's Video menu (macOS lists every camera there once it is live). */
export function selectFaceTimeCameraScript(camera: string): string {
  const name = JSON.stringify(camera)
  return `tell application "System Events"
\tif not (exists process "FaceTime") then return "no-facetime"
\ttell process "FaceTime"
\t\ttry
\t\t\tclick menu item ${name} of menu 1 of menu bar item "Video" of menu bar 1
\t\t\treturn "selected"
\t\ton error
\t\t\treturn "no-camera"
\t\tend try
\tend tell
end tell`
}

/** `not-started`: the button was clicked but OBS's camera did not come on (its macOS camera extension is not approved). */
export type ObsCameraState = 'started' | 'already-on' | 'not-running' | 'no-button' | 'not-started' | 'failed'
export type FaceTimeCameraState = 'selected' | 'no-facetime' | 'no-camera' | 'failed'

export interface CallCameraDeps {
  run(script: string): Promise<string>
  open(app: string): Promise<void>
  sleep(ms: number): Promise<void>
}

const defaults: CallCameraDeps = {
  run: (script) => runAppleScript(script, { timeoutMs: 15_000 }),
  open: async (app) => void (await exec('open', ['-g', '-a', app]).catch(() => '')),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/** Starts OBS's Virtual Camera (launching OBS first if it isn't running). Never throws. */
export async function startObsCamera(deps: CallCameraDeps = defaults): Promise<ObsCameraState> {
  try {
    let state = await deps.run(START_OBS_CAMERA_SCRIPT)
    if (state === 'not-running') {
      await deps.open('OBS')
      await deps.sleep(5000)
      state = await deps.run(START_OBS_CAMERA_SCRIPT)
    }
    return state === 'started' || state === 'already-on' || state === 'not-running' || state === 'no-button' || state === 'not-started' ? state : 'failed'
  } catch {
    return 'failed'
  }
}

/**
 * Picks `camera` in FaceTime, trying for up to `waitMs`: FaceTime's menu only lists the camera a
 * moment after OBS starts publishing it, and only once the call's FaceTime is running. Never throws.
 */
export async function selectFaceTimeCamera(
  camera = OBS_CAMERA,
  deps: CallCameraDeps = defaults,
  waitMs = 12_000,
  everyMs = 1500
): Promise<FaceTimeCameraState> {
  const script = selectFaceTimeCameraScript(camera)
  let last: FaceTimeCameraState = 'failed'
  for (let waited = 0; ; waited += everyMs) {
    try {
      const state = await deps.run(script)
      last = state === 'selected' || state === 'no-facetime' || state === 'no-camera' ? state : 'failed'
    } catch {
      last = 'failed'
    }
    if (last === 'selected' || waited + everyMs > waitMs) return last
    await deps.sleep(everyMs)
  }
}
