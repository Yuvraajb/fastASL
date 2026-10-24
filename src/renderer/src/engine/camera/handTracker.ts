import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type HandLandmarkerResult,
  type NormalizedLandmark
} from '@mediapipe/tasks-vision'
import type { Landmark } from '@shared/types'
import { assetExists } from '../assets'
import type { FrameSample } from '../types'

export type Delegate = 'GPU' | 'CPU'

/**
 * What to track besides the hands, for the pretrained sign model: the face (the Kaggle model) and
 * the body pose (ASL Citizen). Each loads the first time it is asked for.
 */
export interface Extras {
  face: boolean
  pose: boolean
}

export const NO_EXTRAS: Extras = { face: false, pose: false }

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>

export interface HandTracker {
  readonly delegate: Delegate
  /**
   * Runs MediaPipe on the current frame: the hands every frame, the face and pose (when asked for
   * and loaded) on alternating frames, each reusing its last result in between. Synchronous;
   * timestamps are forced to increase.
   */
  detect(element: HTMLVideoElement | HTMLCanvasElement, tMs: number, extras?: Extras): FrameSample
  /** Mean ms per call of each model since the last call (dev diagnostics); null until one ran. */
  takeTimings(): { hands: number; face: number | null; pose: number | null; frames: number } | null
  close(): void
}

const TASK_OPTIONS = {
  runningMode: 'VIDEO',
  numHands: 2,
  minHandDetectionConfidence: 0.6,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5
} as const

export function toFrameSample(result: HandLandmarkerResult, t: number): FrameSample {
  return {
    t,
    hands: result.landmarks.map((points, i) => {
      const category = result.handedness[i]?.[0]
      return {
        landmarks: points.map(({ x, y, z }) => ({ x, y, z })),
        handedness: category?.categoryName === 'Left' ? 'Left' : 'Right',
        score: category?.score ?? 0
      }
    })
  }
}

/** scripts/fetch-assets.mjs didn't run or failed (offline install, `--ignore-scripts`), so retrying won't help. */
export class MissingAssetsError extends Error {
  constructor() {
    super('Hand tracking files are missing — run npm run setup')
    this.name = 'MissingAssetsError'
  }
}

/**
 * Loads MediaPipe HandLandmarker from the bundled assets (`public/mediapipe/`,
 * see scripts/fetch-assets.mjs). Tries the GPU delegate first and falls back to
 * CPU if WebGL setup or the first inference fails.
 */
export async function createHandTracker(): Promise<HandTracker> {
  const fileset = await FilesetResolver.forVisionTasks(new URL('./mediapipe/wasm', location.href).href)
  const modelAssetPath = new URL('./mediapipe/hand_landmarker.task', location.href).href
  const found = await Promise.all([fileset.wasmLoaderPath, fileset.wasmBinaryPath, modelAssetPath].map(assetExists))
  if (found.includes(false)) throw new MissingAssetsError()

  const load = async (delegate: Delegate): Promise<HandLandmarker> => {
    const landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      ...TASK_OPTIONS
    }).catch((err: unknown) => {
      // A <script> that fails to load rejects with a DOM Event, not an Error.
      throw err instanceof Error ? err : new Error('the MediaPipe runtime script failed to load')
    })
    try {
      // Warm-up on a blank frame: compiles GPU shaders now rather than on the first
      // camera frame, and surfaces GPU failures while we can still fall back.
      landmarker.detectForVideo(new ImageData(32, 32), 0)
    } catch (err) {
      landmarker.close()
      throw err
    }
    return landmarker
  }

  let delegate: Delegate = 'GPU'
  let landmarker: HandLandmarker
  try {
    landmarker = await load('GPU')
  } catch (err) {
    console.warn('[handTracker] GPU delegate failed, using CPU', err)
    delegate = 'CPU'
    landmarker = await load('CPU')
  }

  const face = extraTracker('face', fileset, delegate)
  const pose = extraTracker('pose', fileset, delegate)
  const handTime = new Timing()
  let frameNo = 0
  let lastT = 0
  return {
    delegate,
    detect(element, tMs, extras = NO_EXTRAS) {
      const t = tMs > lastT ? tMs : lastT + 1
      lastT = t
      const sample = handTime.time(() => toFrameSample(landmarker.detectForVideo(element, t), t))
      // At most one extra model per frame: the face on even frames, the pose on odd ones, each
      // reusing its last result in between (see EXTRA_MAX_AGE_MS).
      const faceDue = frameNo++ % 2 === 0
      if (extras.face && faceDue) face.detect(element, t)
      if (extras.pose && !faceDue) pose.detect(element, t)
      const facePoints = extras.face ? face.recent(t) : null
      const posePoints = extras.pose ? pose.recent(t) : null
      if (facePoints) sample.face = facePoints
      if (posePoints) sample.pose = posePoints
      return sample
    },
    takeTimings() {
      const hands = handTime.take()
      if (hands === null) return null
      return { hands, face: face.timing.take(), pose: pose.timing.take(), frames: handTime.lastCount }
    },
    close: () => {
      landmarker.close()
      face.close()
      pose.close()
    }
  }
}

/** Mean duration of the calls timed since the last take(). */
class Timing {
  private total = 0
  private count = 0
  lastCount = 0
  time<T>(fn: () => T): T {
    const t0 = performance.now()
    try {
      return fn()
    } finally {
      this.total += performance.now() - t0
      this.count++
    }
  }
  take(): number | null {
    const mean = this.count ? this.total / this.count : null
    this.lastCount = this.count
    this.total = 0
    this.count = 0
    return mean
  }
}

/** A result older than this is not reused: the face or pose was lost, or tracking paused. */
const EXTRA_MAX_AGE_MS = 150
const FACE_MODEL = './mediapipe/face_landmarker.task'
const POSE_MODEL = './mediapipe/pose_landmarker_lite.task'

interface ExtraTracker {
  detect(element: HTMLVideoElement | HTMLCanvasElement, t: number): void
  /** The last result, if it is recent enough to stand for frame time `t`. */
  recent(t: number): Landmark[] | null
  timing: Timing
  close(): void
}

/**
 * FaceLandmarker or PoseLandmarker, loaded on first use with the hands' delegate. A missing model
 * file (scripts/fetch-assets.mjs didn't fetch it) or a failed load leaves it off for the session,
 * with one console warning: the sign model then runs without it, less accurately.
 */
function extraTracker(kind: 'face' | 'pose', fileset: Fileset, delegate: Delegate): ExtraTracker {
  type Runner = { run(element: HTMLVideoElement | HTMLCanvasElement, t: number): NormalizedLandmark[] | undefined; close(): void }
  let state: 'unloaded' | 'loading' | 'ready' | 'off' = 'unloaded'
  let runner: Runner | null = null
  let last: { t: number; points: Landmark[] } | null = null
  const timing = new Timing()
  const load = async (): Promise<void> => {
    const modelAssetPath = new URL(kind === 'face' ? FACE_MODEL : POSE_MODEL, location.href).href
    if (!(await assetExists(modelAssetPath))) throw new Error(`${modelAssetPath} is missing — run npm run setup`)
    const baseOptions = { modelAssetPath, delegate }
    if (kind === 'face') {
      const face = await FaceLandmarker.createFromOptions(fileset, { baseOptions, runningMode: 'VIDEO', numFaces: 1 })
      runner = { run: (el, t) => face.detectForVideo(el, t).faceLandmarks[0], close: () => face.close() }
    } else {
      const pose = await PoseLandmarker.createFromOptions(fileset, { baseOptions, runningMode: 'VIDEO', numPoses: 1 })
      runner = {
        run: (el, t) => {
          let points: NormalizedLandmark[] | undefined
          pose.detectForVideo(el, t, (result) => (points = result.landmarks[0]))
          return points
        },
        close: () => pose.close()
      }
    }
  }
  return {
    timing,
    detect(element, t) {
      if (state === 'unloaded') {
        state = 'loading'
        load().then(
          () => {
            if (state === 'loading') state = runner ? 'ready' : 'off'
            else runner?.close() // closed while loading
          },
          (err: unknown) => {
            state = 'off'
            console.warn(`[handTracker] ${kind} tracking is off:`, err instanceof Error ? err.message : err)
          }
        )
        return
      }
      if (state !== 'ready' || !runner) return
      const r = runner
      try {
        const points = timing.time(() => r.run(element, t))
        last = points ? { t, points: points.map(({ x, y, z }) => ({ x, y, z })) } : null
      } catch (err) {
        // A broken face or pose model must not take the hands down with it.
        state = 'off'
        runner = null
        r.close()
        console.warn(`[handTracker] ${kind} tracking stopped:`, err)
      }
    },
    recent: (t) => (last && t - last.t <= EXTRA_MAX_AGE_MS ? last.points : null),
    close() {
      runner?.close()
      runner = null
      state = 'off'
    }
  }
}
