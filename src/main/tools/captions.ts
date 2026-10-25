import { getCaptionsControl } from '../captionsControl'
import { fail } from './outcome'
import { defineTool } from './types'

/** The window OBS captures (Window Capture of "fastASL Captions" -> OBS Virtual Camera -> FaceTime's camera). */
const WINDOW = 'fastASL Captions'

export const captionsOn = defineTool({
  name: 'captions_on',
  description:
    'Turn on live captions for a video call: opens the "fastASL Captions" window, where what the user signs becomes English captions ' +
    'for the person on the call (OBS shows that window as its Virtual Camera, which FaceTime uses as the camera). ' +
    'Call it right after a FaceTime call starts, unless the user asked for no captions. While it is on, the user\'s signs go to the call, not to you.',
  schema: {},
  risk: 'read',
  stepLabel: () => 'Turning on live captions',
  async run() {
    const control = getCaptionsControl()
    if (!control) return fail("Captions aren't available yet: the fastASL window is still starting")
    control.open()
    return {
      ok: true,
      text: `Live captions are on: the "${WINDOW}" window is open, and what the user signs is captioned for the call.`,
      title: 'Live captions on',
      subtitle: 'Your signs are captioned on the call'
    }
  }
})

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
