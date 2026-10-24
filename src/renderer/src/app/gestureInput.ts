import { shapeMatcher } from '../engine/gestures/customShapes'
import { GestureEngine, gestureKey, type GestureProgress } from '../engine/gestures/engine'
import { SENSITIVITY, type FrameSample } from '../engine/types'
import { activeGestures, gestureScreen, type Controller } from './controller'
import { live } from './live'
import { getApp, setApp, useApp } from './store'

const IDLE: GestureProgress = { palmHold: 0, pick: null, shape: null }

export interface GestureConnection {
  stop(): void
  /** Whatever a hand shows now must be released before it can fire (e.g. a recognized word's last handshape). */
  spendShown(): void
  /** A hold gesture (fist, thumbs up, palm, finger count, shape) is timing toward firing. */
  holding(): boolean
}

/**
 * Connects the gesture engine to the app: live camera frames go in, fired gestures go to
 * controller.gesture (which gates them by view again), and hold progress goes to the store
 * (holdProgress: the collapsed pill's ring; pick: the option badges). The engine evaluates
 * only the current view's (and mode's) gestures, follows the sensitivity setting and
 * matches the saved gesture shapes (store.gestures).
 */
export function connectGestures(
  controller: Pick<Controller, 'gesture'>,
  subscribeFrames: (fn: (frame: FrameSample) => void) => () => void
): GestureConnection {
  const { view, mode, sensitivity } = getApp()
  const engine = new GestureEngine({ sensitivity: SENSITIVITY[sensitivity] })
  engine.setActive(activeGestures(view, mode))
  // Each camera session (new source, restart, camera turned back on) has its own element.
  let session: CanvasImageSource | null = null
  let aspect = 0
  // Shapes are compared in the camera's aspect, as they were recorded (staticFeatures).
  const matchShapes = (): void => engine.setShapeMatcher(shapeMatcher(getApp().gestures, aspect || 1))
  matchShapes()

  const stopStore = useApp.subscribe((s, prev) => {
    if (s.view !== prev.view || s.mode !== prev.mode) engine.setActive(activeGestures(s.view, s.mode))
    // A new screen needs a fresh gesture: whatever is held as it appears must be released first.
    if (gestureScreen(s.view) !== gestureScreen(prev.view)) engine.spendShown()
    if (s.sensitivity !== prev.sensitivity) engine.setSensitivity(SENSITIVITY[s.sensitivity])
    if (s.gestures !== prev.gestures) matchShapes()
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
      matchShapes()
    }
    for (const input of engine.update(frame)) {
      if (window.fastasl?.isDev) console.log(`[gesture] ${gestureKey(input)} in ${getApp().view.kind}`)
      controller.gesture(input)
    }
    showProgress(engine.progress())
  })

  return {
    stop() {
      stopFrames()
      stopStore()
    },
    spendShown: () => engine.spendShown(),
    holding: () => engine.holding()
  }
}

/** Writes hold progress to the store only when it changed, so idle frames don't re-render. */
function showProgress({ palmHold, pick }: GestureProgress): void {
  const s = getApp()
  if (palmHold === s.holdProgress && pick?.count === s.pick?.count && pick?.progress === s.pick?.progress) return
  setApp({ holdProgress: palmHold, pick })
}
