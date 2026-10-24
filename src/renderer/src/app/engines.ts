import { CameraPipeline } from '../engine/camera/pipeline'
import type { FrameSample } from '../engine/types'
import type { Controller } from './controller'
import { connectGestures } from './gestureInput'
import { live } from './live'
import { getApp, useApp } from './store'

/**
 * The single owner of the camera pipeline and the engines fed by it (gestures; recognition
 * from Phase 4). App starts it on launch, except in screenshot / ?mock=1 mode where the feed
 * keeps its mock hand. Camera settings flow in through the store: controller.toggleCamera sets
 * cameraOn, controller.setCameraSource sets cameraSource. Engine output goes to the controller.
 */
const camera = new CameraPipeline()

/** Every tracked frame, plus an empty frame whenever the camera goes away. */
export function subscribeFrames(fn: (frame: FrameSample) => void): () => void {
  return camera.subscribe(fn)
}

/** Starts the camera with the store's settings and follows later changes. Returns a stop function. */
export function startEngines(controller: Controller): () => void {
  const { cameraOn, cameraSource } = getApp()
  const stopGestures = connectGestures(controller, subscribeFrames)
  void camera.setEnabled(cameraOn)
  void camera.start(cameraSource)
  const unsubscribe = useApp.subscribe((s, prev) => {
    if (s.cameraOn !== prev.cameraOn) void camera.setEnabled(s.cameraOn)
    if (s.cameraSource !== prev.cameraSource) void camera.setSource(s.cameraSource)
  })
  const stopLog = window.fastasl?.isDev ? logCameraStatus() : null
  return () => {
    unsubscribe()
    stopLog?.()
    camera.stop()
    stopGestures()
  }
}

/** Dev only: a console line whenever the camera status changes (FASTASL_LOG=1 prints it to stdout). */
function logCameraStatus(): () => void {
  let last = ''
  const timer = setInterval(() => {
    const state = live.mock ? `mock hand${live.error ? ` (${live.error})` : ''}` : `live ${live.sourceWidth}x${live.sourceHeight}`
    const line = `[camera] ${state} · ${live.fps.toFixed(0)} fps · ${live.hands.length} hand(s)`
    if (line !== last) console.log(line)
    last = line
  }, 2000)
  return () => clearInterval(timer)
}
