import type { Landmark } from '@shared/types'
import type { FaceBox } from '../types'

/** FaceLandmarker's mesh points; 468-477 are the irises, inside the box anyway. */
const MESH_POINTS = 468

/**
 * The face box from FaceLandmarker's points (FrameSample.face): the bounding box of the face mesh,
 * from the top of the forehead to the chin and cheek to cheek, as fractions of the image. Null
 * with no face or a degenerate one. The camera already runs FaceLandmarker for the sign model, so
 * the streaming signs need no face detector of their own.
 */
export function faceBoxOf(points: readonly Landmark[] | undefined): FaceBox | null {
  if (!points?.length) return null
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  const n = Math.min(points.length, MESH_POINTS)
  for (let i = 0; i < n; i++) {
    const { x, y } = points[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const w = x1 - x0
  const h = y1 - y0
  if (!(w > 0) || !(h > 0)) return null
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h }
}
