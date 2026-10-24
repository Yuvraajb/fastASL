import type { CameraSource } from '@shared/types'
import { live as sharedLive, type LiveFrame } from '../../app/live'
import type { FrameSample } from '../types'
import { openCamera, type CameraHandle } from './cameraSource'
import { createHandTracker, MissingAssetsError, type HandTracker } from './handTracker'
import { INITIAL_MOTION, stepMotion, type MotionState } from './motion'

export interface PipelineDeps {
  openCamera(source: CameraSource): Promise<CameraHandle>
  createHandTracker(): Promise<HandTracker>
  /** Calls `cb` once when the handle may have a new frame; returns a cancel function. */
  nextFrame(handle: CameraHandle, cb: () => void): () => void
  now(): number
  live: LiveFrame
}

/**
 * Caps detection at ~30/s: every 2nd tick at 60 Hz, every 4th at 120 Hz. Below 33ms
 * so a 30 fps camera whose frames arrive a few ms early still gets every frame.
 */
const MIN_DETECT_INTERVAL_MS = 26
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 10_000
const FPS_SMOOTHING = 0.1

/** requestVideoFrameCallback for <video> (one call per decoded frame), else requestAnimationFrame. */
function nextFrame(handle: CameraHandle, cb: () => void): () => void {
  const el = handle.element
  if (el instanceof HTMLVideoElement && 'requestVideoFrameCallback' in el) {
    const id = el.requestVideoFrameCallback(() => cb())
    return () => el.cancelVideoFrameCallback(id)
  }
  const id = requestAnimationFrame(() => cb())
  return () => cancelAnimationFrame(id)
}

const DEFAULT_DEPS: PipelineDeps = {
  openCamera,
  createHandTracker,
  nextFrame,
  now: () => performance.now(),
  live: sharedLive
}

export function sameSource(a: CameraSource | null, b: CameraSource | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'builtin' && b.kind === 'builtin') return (a.deviceId ?? '') === (b.deviceId ?? '')
  return a.kind === 'mjpeg' && b.kind === 'mjpeg' && a.url === b.url
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Camera -> MediaPipe -> `live` + subscribers. Owns at most one open camera.
 * Whenever there is no working camera (disabled, failed, stopped) `live` falls
 * back to the mock hand; failures retry with backoff until the camera returns
 * (except missing MediaPipe files, which wait for a relaunch, a camera toggle or a new source).
 */
export class CameraPipeline {
  private readonly deps: PipelineDeps
  private readonly subscribers = new Set<(frame: FrameSample) => void>()
  private source: CameraSource | null = null
  private running = false
  private enabled = true
  /** Bumped on every teardown; async work from an older session discards itself. */
  private session = 0
  private handle: CameraHandle | null = null
  private tracker: Promise<HandTracker> | null = null
  private cancelFrame: (() => void) | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_MIN_MS
  private motion: MotionState = INITIAL_MOTION
  private lastDetect: number | null = null
  private intervalEma = 0

  constructor(deps: Partial<PipelineDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps }
  }

  start(source: CameraSource): Promise<void> {
    this.running = true
    this.source = source
    return this.restart()
  }

  stop(): void {
    this.running = false
    this.teardown(null)
  }

  setSource(source: CameraSource): Promise<void> {
    if (sameSource(this.source, source)) return Promise.resolve()
    this.source = source
    return this.running ? this.restart() : Promise.resolve()
  }

  setEnabled(on: boolean): Promise<void> {
    if (on === this.enabled) return Promise.resolve()
    this.enabled = on
    if (!on) {
      this.teardown(null)
      return Promise.resolve()
    }
    return this.running ? this.restart() : Promise.resolve()
  }

  subscribe(fn: (frame: FrameSample) => void): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  /**
   * `retry`: a backoff attempt on the same source, which keeps showing the last
   * error (so the card doesn't flicker) and keeps the backoff. Anything else
   * (start, a new source, re-enable) starts fresh, so no stale error or delay.
   */
  private async restart(retry = false): Promise<void> {
    if (!retry) this.retryDelay = RETRY_MIN_MS
    this.teardown(retry ? this.deps.live.error : null)
    const source = this.source
    if (!this.running || !this.enabled || !source) return
    const session = this.session

    // Tracker first: when it can't load, the camera is never opened, so retries
    // don't blink the camera light or reconnect the ESP32 every few seconds.
    let tracker: HandTracker
    let handle: CameraHandle
    try {
      tracker = await this.loadTracker()
      if (session !== this.session) return
      handle = await this.deps.openCamera(source)
    } catch (err) {
      // Missing MediaPipe files won't appear by themselves: keep the message, no retry.
      if (session === this.session) this.fail(messageOf(err), !(err instanceof MissingAssetsError))
      return
    }
    if (session !== this.session) {
      handle.stop()
      return
    }
    this.handle = handle
    this.schedule(session, tracker, handle)
  }

  private loadTracker(): Promise<HandTracker> {
    this.tracker ??= this.deps.createHandTracker().catch((err: unknown) => {
      this.tracker = null
      throw err instanceof MissingAssetsError ? err : new Error(`Hand tracking failed to load (${messageOf(err)})`)
    })
    return this.tracker
  }

  private schedule(session: number, tracker: HandTracker, handle: CameraHandle): void {
    this.cancelFrame = this.deps.nextFrame(handle, () => this.onFrame(session, tracker, handle))
  }

  private onFrame(session: number, tracker: HandTracker, handle: CameraHandle): void {
    if (session !== this.session) return
    if (handle.error) return this.fail(handle.error)
    const now = this.deps.now()
    const due = this.lastDetect === null || now - this.lastDetect >= MIN_DETECT_INTERVAL_MS
    if (due && handle.width > 0 && handle.height > 0) {
      let frame: FrameSample
      try {
        frame = tracker.detect(handle.element, now)
      } catch (err) {
        // A broken tracker (e.g. lost WebGL context) is rebuilt on retry.
        tracker.close()
        this.tracker = null
        return this.fail(`Hand tracking stopped (${messageOf(err)})`)
      }
      this.publish(frame, handle, now)
    }
    this.schedule(session, tracker, handle)
  }

  private publish(frame: FrameSample, handle: CameraHandle, now: number): void {
    if (this.lastDetect !== null) {
      const interval = now - this.lastDetect
      this.intervalEma = this.intervalEma ? this.intervalEma + FPS_SMOOTHING * (interval - this.intervalEma) : interval
    }
    this.lastDetect = now
    // Only reset the backoff once frames really flow, so a camera that opens and
    // immediately dies doesn't retry at full speed.
    this.retryDelay = RETRY_MIN_MS
    this.motion = stepMotion(this.motion, frame, { aspect: handle.width / handle.height })

    const live = this.deps.live
    live.source = handle.element
    live.sourceWidth = handle.width
    live.sourceHeight = handle.height
    live.hands = frame.hands.map(({ landmarks, handedness }) => ({ landmarks, handedness }))
    live.motion = this.motion.energy
    live.fps = this.intervalEma ? 1000 / this.intervalEma : 0
    live.mock = false
    live.error = null
    this.emit(frame)
  }

  private fail(message: string, retry = true): void {
    this.teardown(message)
    if (!retry) return
    const session = this.session
    this.retryTimer = setTimeout(() => {
      if (session === this.session) void this.restart(true)
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS)
  }

  /** Close the camera and put `live` back on the mock hand. */
  private teardown(error: string | null): void {
    this.session++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.cancelFrame?.()
    this.cancelFrame = null
    this.handle?.stop()
    this.handle = null
    this.motion = INITIAL_MOTION
    this.lastDetect = null
    this.intervalEma = 0

    const live = this.deps.live
    const hadHands = live.hands.length > 0
    Object.assign(live, { source: null, sourceWidth: 0, sourceHeight: 0, hands: [], motion: 0, fps: 0, mock: true, error })
    // Tell consumers the hands are gone rather than leaving them on a stale frame.
    if (hadHands) this.emit({ t: this.deps.now(), hands: [] })
  }

  private emit(frame: FrameSample): void {
    for (const fn of this.subscribers) {
      try {
        fn(frame)
      } catch (err) {
        console.error('[camera] subscriber failed', err)
      }
    }
  }
}
