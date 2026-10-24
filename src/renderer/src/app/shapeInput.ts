import { CAPTURE_MS, captureShape } from '../engine/gestures/customShapes'
import { SENSITIVITY, type FrameSample } from '../engine/types'
import { isCapturingShape, type Controller } from './controller'
import { live } from './live'
import { getApp } from './store'
import type { View } from './types'

/**
 * New gesture › hold: while the card records a shape (isCapturingShape), CAPTURE_MS of
 * camera frames go to captureShape (against the saved gestures and taught letters), and its
 * verdict to controller.shapeCaptured, once per recording. The mock hand is no real hand: its frames are never recorded.
 */
export function connectShapeCapture(
  controller: Pick<Controller, 'shapeCaptured'>,
  subscribeFrames: (fn: (frame: FrameSample) => void) => () => void
): () => void {
  /** The recording view being fed; every new one starts over. */
  let recording: View | null = null
  let frames: FrameSample[] = []
  let judged = false

  return subscribeFrames((frame) => {
    const view = getApp().view
    if (view !== recording) {
      recording = view
      frames = []
      judged = false
    }
    if (judged || !isCapturingShape(view)) return
    if (live.mock) {
      frames = []
      return
    }
    frames.push(frame)
    if (frame.t - frames[0].t < CAPTURE_MS) return
    judged = true
    const { gestures, templates, sensitivity } = getApp()
    const rivals = { gestures, templates, sensitivity: SENSITIVITY[sensitivity] }
    controller.shapeCaptured(captureShape(frames, live.sourceWidth / live.sourceHeight, rivals))
  })
}
