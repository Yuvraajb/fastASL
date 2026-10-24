import { GestureEngine, gestureKey, type GestureProgress } from '../engine/gestures/engine'
import { SENSITIVITY, type FrameSample } from '../engine/types'
import { activeGestures, type Controller } from './controller'
import { live } from './live'
import { getApp, setApp, useApp } from './store'

const IDLE: GestureProgress = { palmHold: 0, pick: null, shape: null }

/**
 * Connects the gesture engine to the app: live camera frames go in, fired gestures go to
 * controller.gesture (which gates them by view again), and hold progress goes to the store
 * (holdProgress: the collapsed pill's ring; pick: the option badges). The engine evaluates
 * only the current view's gestures and follows the sensitivity setting. Returns a stop function.
 */
export function connectGestures(
  controller: Pick<Controller, 'gesture'>,
  subscribeFrames: (fn: (frame: FrameSample) => void) => () => void
): () => void {
  const { view, sensitivity } = getApp()
  const engine = new GestureEngine({ sensitivity: SENSITIVITY[sensitivity] })
  engine.setActive(activeGestures(view))
  // Each camera session (new source, restart, camera turned back on) has its own element.
  let session: CanvasImageSource | null = null
  let aspect = 0

  const stopStore = useApp.subscribe((s, prev) => {
    if (s.view !== prev.view) engine.setActive(activeGestures(s.view))
    // A new screen needs a fresh gesture: whatever is held as it appears must be released first.
    if (s.view.kind !== prev.view.kind) engine.spendShown()
    if (s.sensitivity !== prev.sensitivity) engine.setSensitivity(SENSITIVITY[s.sensitivity])
  })

  const stopFrames = subscribeFrames((frame) => {
    // The feed shows the mock hand: not a real hand. The pipeline sends one empty frame
    // in this state when the camera goes away, which clears any half-filled ring.
    if (live.mock) {
      session = null
      return showProgress(IDLE)
    }
    // A new session or a resized MJPEG stream: no motion history, holds or cooldowns carry over.
    const frameAspect = live.sourceWidth / live.sourceHeight
    if (live.source !== session || frameAspect !== aspect) {
      session = live.source
      aspect = frameAspect
      engine.setAspect(aspect)
      engine.reset()
    }
    for (const input of engine.update(frame)) {
      if (window.fastasl?.isDev) console.log(`[gesture] ${gestureKey(input)} in ${getApp().view.kind}`)
      controller.gesture(input)
    }
    showProgress(engine.progress())
  })

  return () => {
    stopFrames()
    stopStore()
  }
}

/** Writes hold progress to the store only when it changed, so idle frames don't re-render. */
function showProgress({ palmHold, pick }: GestureProgress): void {
  const s = getApp()
  if (palmHold === s.holdProgress && pick?.count === s.pick?.count && pick?.progress === s.pick?.progress) return
  setApp({ holdProgress: palmHold, pick })
}
