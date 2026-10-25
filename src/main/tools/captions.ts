import { getCaptionsControl } from '../captionsControl'
import { OBS_CAMERA, selectFaceTimeCamera, startObsCamera, type FaceTimeCameraState, type ObsCameraState } from '../mac/callCamera'
import { fail } from './outcome'
import { defineTool, type ToolDef } from './types'

/** The window OBS captures (Window Capture of "fastASL Captions" -> OBS Virtual Camera -> FaceTime's camera). */
const WINDOW = 'fastASL Captions'

/** What happened to the camera switch, in a sentence the model can pass on (a step that didn't work says how to finish it by hand). */
export function cameraNote(obs: ObsCameraState, facetime: FaceTimeCameraState): string {
  const parts: string[] = []
  if (obs === 'started') parts.push('OBS Virtual Camera started.')
  else if (obs === 'not-running') parts.push('OBS is not running: open OBS and click Start Virtual Camera.')
  else if (obs === 'not-started') parts.push("OBS's Virtual Camera did not start: approve the OBS camera extension in System Settings > General > Login Items & Extensions > Camera Extensions, then try again.")
  else if (obs === 'no-button') parts.push('Could not find OBS\'s Start Virtual Camera button: start it in OBS.')
  else if (obs === 'failed') parts.push('Could not start OBS\'s Virtual Camera: start it in OBS (it may need Accessibility access).')
  if (facetime === 'selected') parts.push(`FaceTime is using ${OBS_CAMERA}.`)
  else if (facetime === 'no-facetime') parts.push('FaceTime is not open yet.')
  else if (facetime === 'no-camera') parts.push(`FaceTime does not list ${OBS_CAMERA} yet: pick it under Video > Camera.`)
  else parts.push(`Could not pick ${OBS_CAMERA} in FaceTime: pick it under Video > Camera.`)
  return parts.join(' ')
}

export const captionsOn = defineTool({
  name: 'captions_on',
  description:
    'Turn on live captions for a video call: opens the "fastASL Captions" window, where what the user signs becomes English captions ' +
    'for the person on the call (OBS shows that window as its Virtual Camera, which FaceTime uses as the camera). ' +
    'It also starts OBS\'s Virtual Camera and makes it FaceTime\'s camera, so the caption feed is the video the other person sees. ' +
    'Call it right after a FaceTime call starts, unless the user asked for no captions. While it is on, the user\'s signs go to the call, not to you.',
  schema: {},
  risk: 'read',
  stepLabel: () => 'Turning on live captions',
  async run() {
    const control = getCaptionsControl()
    if (!control) return fail("Captions aren't available yet: the fastASL window is still starting")
    control.open()
    const obs = await startObsCamera()
    const facetime = await selectFaceTimeCamera()
    const live = facetime === 'selected'
    return {
      ok: true,
      text: `Live captions are on: the "${WINDOW}" window is open, and what the user signs is captioned for the call. ${cameraNote(obs, facetime)}`,
      title: 'Live captions on',
      subtitle: live ? `The call's camera is ${OBS_CAMERA}` : 'Your signs are captioned on the call'
    }
  }
})

/**
 * A video call that starts with the live caption camera by default, and starts at once. The captions
 * window and OBS's Virtual Camera come up BEFORE the call is placed (instant when the window is
 * already open), then FaceTime is pointed at the camera as soon as it is up. For the demo the call
 * is allowed without a confirm card. An audio-only call has no video, so it is left alone, and a
 * call that did not start gets no camera switch.
 */
export function withLiveCaptions<T extends ToolDef>(call: T): T {
  return {
    ...call,
    risk: 'read',
    confirmDetails: undefined,
    async run(args: Parameters<T['run']>[0]) {
      if ((args as { audio_only?: boolean }).audio_only) return call.run(args)
      const control = getCaptionsControl()
      control?.open()
      const obs = await startObsCamera()
      const placed = await call.run(args)
      if (!placed.ok) return placed
      const facetime = await selectFaceTimeCamera()
      const note = control ? cameraNote(obs, facetime) : "Captions aren't available yet: the fastASL window is still starting."
      return {
        ...placed,
        text: `${placed.text} Live captions are on. ${note}`,
        subtitle: control ? `${placed.subtitle ?? 'FaceTime video'} · live captions` : placed.subtitle
      }
    }
  }
}

export const captionsOff = defineTool({
  name: 'captions_off',
  description:
    'Turn off live captions: closes the "fastASL Captions" window, and what the user signs goes to you again. Use when the call is over or the user asks to stop the captions.',
  schema: {},
  risk: 'read',
  stepLabel: () => 'Turning off live captions',
  async run() {
    const control = getCaptionsControl()
    if (!control) return fail("Captions aren't available yet: the fastASL window is still starting")
    control.close()
    return { ok: true, text: 'Live captions are off. What the user signs goes to the agent again.', title: 'Live captions off' }
  }
})
