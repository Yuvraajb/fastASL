import type { Landmark } from '@shared/types'
import type { FrameSample, HandSample } from '../types'

/**
 * Model inputs built from tracked camera frames. Both pretrained models were trained on
 * MediaPipe Holistic landmarks of unmirrored video, in the signer's own terms: "right hand" is
 * the signer's right hand, which appears on the LEFT of the raw image.
 *
 * HandLandmarker's handedness labels assume a mirrored (selfie) image, and the camera pipeline
 * feeds it raw frames, so the hand it labels 'Left' is the signer's right hand. Swapped slots
 * cost almost all accuracy (0.5% on the Kaggle model), so recognition also runs the swapped
 * assignment and keeps the more confident answer (signModel.ts).
 */

export interface SignerHands {
  right: HandSample | null
  left: HandSample | null
}

/**
 * The signer's own hands. Two hands with the same label (a tracking flicker) are told apart by
 * position: the one on the image's left is the signer's right.
 */
export function signerHands(hands: readonly HandSample[]): SignerHands {
  if (hands.length === 0) return { right: null, left: null }
  if (hands.length === 1) {
    const [hand] = hands
    return hand.handedness === 'Left' ? { right: hand, left: null } : { right: null, left: hand }
  }
  const [a, b] = hands
  if (a.handedness !== b.handedness) return a.handedness === 'Left' ? { right: a, left: b } : { right: b, left: a }
  return a.landmarks[0].x <= b.landmarks[0].x ? { right: a, left: b } : { right: b, left: a }
}

// ------------------------------------------------------------------- Kaggle ISLR (1st place)

/** Points per frame in the Kaggle "asl-signs" layout: face 0-467, left hand 468-488, pose 489-521, right hand 522-542. */
export const ISLR_POINTS = 543
export const ISLR_FACE_POINTS = 468
const ISLR_LEFT_HAND = 468
const ISLR_RIGHT_HAND = 522

/**
 * [T, 543, 3] float32: x, y, z in raw image coordinates (0..1), NaN where a point is missing.
 * The face's first 468 points (FaceLandmarker adds 10 iris points) fill 0-467; pose stays NaN
 * (the model doesn't use it). `swap` puts each hand in the other hand's slot.
 */
export function islrInput(frames: readonly FrameSample[], swap = false): Float32Array {
  const data = new Float32Array(frames.length * ISLR_POINTS * 3).fill(NaN)
  frames.forEach((frame, t) => {
    const base = t * ISLR_POINTS
    if (frame.face) put(data, base, frame.face, ISLR_FACE_POINTS)
    const { right, left } = signerHands(frame.hands)
    const [r, l] = swap ? [left, right] : [right, left]
    if (r) put(data, base + ISLR_RIGHT_HAND, r.landmarks, 21)
    if (l) put(data, base + ISLR_LEFT_HAND, l.landmarks, 21)
  })
  return data
}

function put(data: Float32Array, point: number, landmarks: readonly Landmark[], count: number): void {
  const n = Math.min(count, landmarks.length)
  for (let i = 0; i < n; i++) {
    const { x, y, z } = landmarks[i]
    const o = (point + i) * 3
    data[o] = x
    data[o + 1] = y
    data[o + 2] = z
  }
}

/** Whether any frame had a face (the dev log says so: without one the model is less sure). */
export function hasFace(frames: readonly FrameSample[]): boolean {
  return frames.some((f) => (f.face?.length ?? 0) >= ISLR_FACE_POINTS)
}

// ------------------------------------------------------------------- ASL Citizen ST-GCN

/** Frames per ST-GCN input: longer movements are downsampled, shorter ones zero-padded. */
export const CITIZEN_FRAMES = 128
/**
 * The 27 points the ST-GCN uses, as indices into pose 0-32 + left hand 33-53 + right hand 54-74:
 * nose, eyes, shoulders, elbows, and per hand the wrist, thumb tip and each finger's base and tip.
 */
export const CITIZEN_KEYPOINTS = [
  0, 2, 5, 11, 12, 13, 14, 33, 37, 38, 41, 42, 45, 46, 49, 50, 53, 54, 58, 59, 62, 63, 66, 67, 70, 71, 74
] as const
const CITIZEN_RAW_POINTS = 75
const POSE_POINTS = 33
const SHOULDER_L = 11
const SHOULDER_R = 12

/** Whether the frames carry the body pose the ST-GCN needs (its shoulders normalize everything). */
export function hasPose(frames: readonly FrameSample[]): boolean {
  return frames.some((f) => (f.pose?.length ?? 0) >= POSE_POINTS)
}

/**
 * [2, 128, 27] float32 (x then y planes), exactly as ASL Citizen's pose dataset prepares a clip:
 * missing points are 0; a clip longer than 128 frames keeps 128 by its stepping rule; a shorter
 * one is padded with zero frames, and those padded frames count in the shoulder centre and
 * width that every point is normalized by (as in training).
 */
export function citizenInput(frames: readonly FrameSample[], swap = false): Float32Array {
  let raw = frames.map((frame) => {
    const points = new Float32Array(CITIZEN_RAW_POINTS * 2)
    if (frame.pose) putXY(points, 0, frame.pose, POSE_POINTS)
    const { right, left } = signerHands(frame.hands)
    const [r, l] = swap ? [left, right] : [right, left]
    if (l) putXY(points, POSE_POINTS, l.landmarks, 21)
    if (r) putXY(points, POSE_POINTS + 21, r.landmarks, 21)
    return points
  })
  if (raw.length > CITIZEN_FRAMES) raw = downsample(raw, CITIZEN_FRAMES)
  while (raw.length < CITIZEN_FRAMES) raw.push(new Float32Array(CITIZEN_RAW_POINTS * 2))

  let cx = 0
  let cy = 0
  let width = 0
  for (const p of raw) {
    const [lx, ly, rx, ry] = [p[SHOULDER_L * 2], p[SHOULDER_L * 2 + 1], p[SHOULDER_R * 2], p[SHOULDER_R * 2 + 1]]
    cx += (lx + rx) / 2
    cy += (ly + ry) / 2
    width += Math.hypot(lx - rx, ly - ry)
  }
  cx /= raw.length
  cy /= raw.length
  width /= raw.length
  const scale = width !== 0 ? 1 / width : 1
  const [ox, oy] = width !== 0 ? [cx, cy] : [0, 0]

  const out = new Float32Array(2 * CITIZEN_FRAMES * CITIZEN_KEYPOINTS.length)
  const plane = CITIZEN_FRAMES * CITIZEN_KEYPOINTS.length
  raw.forEach((p, t) => {
    CITIZEN_KEYPOINTS.forEach((k, v) => {
      const o = t * CITIZEN_KEYPOINTS.length + v
      out[o] = (p[k * 2] - ox) * scale
      out[plane + o] = (p[k * 2 + 1] - oy) * scale
    })
  })
  return out
}

/** Missing coordinates (NaN from a partial track) become 0, like Holistic's missing points. */
function putXY(points: Float32Array, point: number, landmarks: readonly Landmark[], count: number): void {
  const n = Math.min(count, landmarks.length)
  for (let i = 0; i < n; i++) {
    const { x, y } = landmarks[i]
    points[(point + i) * 2] = Number.isFinite(x) ? x : 0
    points[(point + i) * 2 + 1] = Number.isFinite(y) ? y : 0
  }
}

/** ASL Citizen's frame stepping for clips longer than `max` frames (keeps about `max`, evenly). */
export function downsample<T>(frames: readonly T[], max: number): T[] {
  const inc = Math.min(1, max / frames.length)
  let acc = 0
  let taken = 0
  const out: T[] = []
  for (const f of frames) {
    acc += inc
    if (acc > taken) {
      taken++
      out.push(f)
    }
  }
  return out.slice(0, max)
}
