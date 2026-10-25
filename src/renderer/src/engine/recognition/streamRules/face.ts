import type { Landmark } from '@shared/types'
import type { FrameSample } from '../../types'
import type { FaceBox, StreamContext } from './types'

/** FaceLandmarker's mesh points; 468-477 are the irises, inside the box anyway. */
const MESH_POINTS = 468

/**
 * The face box from FaceLandmarker's points (FrameSample.face): the bounding box of the face mesh,
 * forehead top to chin and cheek to cheek, as fractions of the image. Null with no face or a
 * degenerate one. Same definition as the streaming matcher's face box, so rules see one scale
 * whether the box comes from the context or from the frame.
 */
export function faceBoxOf(points: readonly Landmark[] | undefined): FaceBox | null {
  if (!points?.length) return null
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  const n = Math.min(points.length, MESH_POINTS)
  for (let i = 0; i < n; i++) {
    const { x, y } = points[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  const w = x1 - x0
  const h = y1 - y0
  if (!(w > 0) || !(h > 0)) return null
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h }
}

/** A face this long before the current frame is still good enough (the head moves slowly). */
const FACE_FROM_HISTORY_MS = 1000

/**
 * The face to anchor face signs on: the context's box, else the newest face mesh in the history
 * (no older than a second). Undefined when there is no face: face signs then don't fire.
 */
export function faceFor(history: readonly FrameSample[], ctx: StreamContext): FaceBox | undefined {
  if (ctx.face) return ctx.face
  const now = history[history.length - 1]?.t ?? 0
  for (let i = history.length - 1; i >= 0; i--) {
    const frame = history[i]
    if (now - frame.t > FACE_FROM_HISTORY_MS) break
    const box = faceBoxOf(frame.face)
    if (box) return box
  }
  return undefined
}
