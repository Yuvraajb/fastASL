import { FaceDetector, FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision'
import type { FaceBox, FrameSample } from '../types'

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

/** The face moves slowly, so it is looked for on every Nth camera frame and the last box is reused. */
const FACE_EVERY_N_FRAMES = 3
/** A face not seen for this long is forgotten (the person left, or turned away). */
const FACE_FORGET_MS = 1500

/** Loads the optional face detector; without its model or on any failure, signs just use frame regions. */
async function createFaceDetector(fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>): Promise<FaceDetector | null> {
  const modelAssetPath = new URL('./mediapipe/face_detector.tflite', location.href).href
  if (!(await assetExists(modelAssetPath))) return null
  try {
    return await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: 'CPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5
    })
  } catch (err) {
    console.warn('[handTracker] face detector unavailable, using frame regions', err)
    return null
  }
}

/** The biggest face in the result as a fraction of the image, or null. */
export function faceBoxOf(result: { detections: { boundingBox?: { originX: number; originY: number; width: number; height: number } }[] }, width: number, height: number): FaceBox | null {
  let best: FaceBox | null = null
  for (const d of result.detections) {
    const b = d.boundingBox
    if (!b || !(width > 0) || !(height > 0)) continue
    const box = { cx: (b.originX + b.width / 2) / width, cy: (b.originY + b.height / 2) / height, w: b.width / width, h: b.height / height }
    if (!best || box.w * box.h > best.w * best.h) best = box
  }
  return best
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

  const faces = await createFaceDetector(fileset)
  let lastT = 0
  let frames = 0
  let face: FaceBox | undefined
  let faceSeenAt = -Infinity
  return {
    delegate,
    detect(element, tMs) {
      const t = tMs > lastT ? tMs : lastT + 1
      lastT = t
      const sample = toFrameSample(landmarker.detectForVideo(element, t), t)
      if (faces && frames++ % FACE_EVERY_N_FRAMES === 0) {
        try {
          const width = element instanceof HTMLVideoElement ? element.videoWidth : element.width
          const height = element instanceof HTMLVideoElement ? element.videoHeight : element.height
          const found = faceBoxOf(faces.detectForVideo(element, t), width, height)
          if (found) {
            face = found
            faceSeenAt = t
          }
        } catch {
          // A failed face frame keeps the last box; hands are what matter.
        }
      }
      if (face && t - faceSeenAt <= FACE_FORGET_MS) sample.face = face
      return sample
    },
    close: () => {
      landmarker.close()
      faces?.close()
    }
  }
}
