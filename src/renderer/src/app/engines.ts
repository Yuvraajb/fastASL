import { canvasEncoder, FrameRing } from '../engine/camera/frameRing'
import { CameraPipeline } from '../engine/camera/pipeline'
import { loadSignModel, MissingModelError } from '../engine/model/runtime'
import type { SignModel } from '../engine/model/signModel'
import { knownSigns } from '../engine/model/vocabulary'
import type { FrameSample } from '../engine/types'
import { showsSign, takesSigns, type Controller } from './controller'
import { connectGestures } from './gestureInput'
import { connectRecognition } from './recognitionInput'
import { connectShapeCapture } from './shapeInput'
import { live } from './live'
import { getApp, setApp, useApp } from './store'

/**
 * The single owner of the camera pipeline and the engines fed by it (gestures, sign
 * recognition, the New gesture shape recorder). App starts it on launch, except in
 * screenshot / ?mock=1 mode where the feed keeps its mock hand. Settings flow in through the
 * store and apply at once: the camera follows cameraOn (the camera button, a source pick) and
 * cameraSource (Settings › Camera source), the engines follow sensitivity. Engine output, and
 * whether the camera works, go to the controller.
 */
const camera = new CameraPipeline()
/** How long the "sign model files are missing" notice stays up. */
const MISSING_MODEL_NOTICE_MS = 10_000

/** Every tracked frame, plus an empty frame whenever the camera goes away. */
export function subscribeFrames(fn: (frame: FrameSample) => void): () => void {
  return camera.subscribe(fn)
}

/** Starts the camera with the store's settings and follows later changes. Returns a stop function. */
export function startEngines(controller: Controller): () => void {
  const { cameraOn, cameraSource } = getApp()
  // Guess, confirm, learn: the last few seconds of frames (small JPEGs at 8 fps), kept only
  // while a guess could use them, so the camera costs nothing extra anywhere else.
  const ring = new FrameRing(canvasEncoder())
  const stopCapture = subscribeFrames((frame) => {
    if (live.mock || !live.source || !controller.wantsSignFrames()) {
      if (ring.all.length) ring.clear()
      return
    }
    ring.offer(live.source, live.sourceWidth, live.sourceHeight, frame.t)
  })
  // The pretrained sign model loads in the background; until then (or without its files) only the
  // taught signs are recognized. Once it is there, the camera tracks the face (and the body pose
  // for ASL Citizen) too, and the LLM is told the model's words.
  let model: SignModel | null = null
  let stopped = false
  const dev = Boolean(window.fastasl?.isDev)
  /**
   * The face is tracked where signs are taken outside Spell mode (streaming signs place the hands
   * against it, and the model reads it); the pose only where the ASL Citizen model can be asked.
   * Elsewhere they cost nothing.
   */
  const trackForModel = (): void => {
    const s = getApp()
    const signing = takesSigns(s.view) && s.mode !== 'spell'
    const forModel = model !== null && (showsSign(s.view) || signing)
    camera.setExtras({ face: signing || forModel, pose: forModel && Boolean(model?.hasCitizen) })
  }
  trackForModel()
  void loadSignModel(dev ? (line) => console.log(line) : undefined).then(
    (loaded) => {
      if (stopped) return
      model = loaded
      trackForModel()
      setApp({ modelWords: knownSigns(loaded.hasCitizen) })
    },
    (err: unknown) => {
      if (stopped) return
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[model] not loaded: ${message}`)
      if (err instanceof MissingModelError) controller.notify(message, MISSING_MODEL_NOTICE_MS)
    }
  )
  const recognition = connectRecognition(controller, () => ring.all, {
    model: () => model,
    holdingGesture: () => gestures.holding()
  })
  // Gestures reach the controller through recognition: a fist is not also an S, nor MUSIC a swipe.
  const gestures = connectGestures({ gesture: recognition.gesture }, subscribeFrames)
  // Subscribed after the gesture engine, so a gesture firing on a frame suspends recognition first.
  const stopRecognition = subscribeFrames((frame) => {
    // The hand often rests in a word's last shape (TOMORROW ends in a thumbs-up, YES in a fist),
    // and a Spell mode letter is still held when it arrives (S is a fist).
    if (recognition.update(frame)) gestures.spendShown()
  })
  const stopShapes = connectShapeCapture(controller, subscribeFrames)
  const stopStatus = camera.onStatus((error) => controller.cameraStatus(error))
  void camera.setEnabled(cameraOn)
  void camera.start(cameraSource)
  const unsubscribe = useApp.subscribe((s, prev) => {
    if (s.cameraOn !== prev.cameraOn) void camera.setEnabled(s.cameraOn)
    if (s.cameraSource !== prev.cameraSource) void camera.setSource(s.cameraSource)
    if (s.view !== prev.view || s.mode !== prev.mode) trackForModel()
  })
  const stopLog = dev ? logCameraStatus() : null
  return () => {
    stopped = true
    camera.setExtras({ face: false, pose: false })
    unsubscribe()
    stopStatus()
    stopLog?.()
    camera.stop()
    stopCapture()
    ring.clear()
    gestures.stop()
    stopRecognition()
    recognition.stop()
    stopShapes()
  }
}

/**
 * Dev only: a console line whenever the camera status changes, and every 10 s the tracker's mean
 * time per call of each MediaPipe model (FASTASL_LOG=1 prints them to stdout).
 */
function logCameraStatus(): () => void {
  let last = ''
  let ticks = 0
  const ms = (v: number | null): string => (v === null ? 'off' : `${v.toFixed(1)} ms`)
  const timer = setInterval(() => {
    const state = live.mock ? `mock hand${live.error ? ` (${live.error})` : ''}` : `live ${live.sourceWidth}x${live.sourceHeight}`
    const line = `[camera] ${state} · ${live.fps.toFixed(0)} fps · ${live.hands.length} hand(s)`
    if (line !== last) console.log(line)
    last = line
    if (++ticks % 5 === 0) {
      void camera.takeTimings().then((t) => {
        if (t) console.log(`[tracker] ${t.frames} frames · hands ${ms(t.hands)} · face ${ms(t.face)} · pose ${ms(t.pose)} per call`)
      })
    }
  }, 2000)
  return () => clearInterval(timer)
}
