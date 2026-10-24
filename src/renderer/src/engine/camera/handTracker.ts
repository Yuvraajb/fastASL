import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision'
import type { FrameSample } from '../types'

export type Delegate = 'GPU' | 'CPU'

export interface HandTracker {
  readonly delegate: Delegate
  /** Runs MediaPipe on the current frame. Synchronous; timestamps are forced to increase. */
  detect(element: HTMLVideoElement | HTMLCanvasElement, tMs: number): FrameSample
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

/** The dev server answers a missing file with index.html, so HTML counts as missing. */
async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url)
    void res.body?.cancel()
    return res.ok && !res.headers.get('content-type')?.includes('text/html')
  } catch {
    return false
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

  let lastT = 0
  return {
    delegate,
    detect(element, tMs) {
      const t = tMs > lastT ? tMs : lastT + 1
      lastT = t
      return toFrameSample(landmarker.detectForVideo(element, t), t)
    },
    close: () => landmarker.close()
  }
}
