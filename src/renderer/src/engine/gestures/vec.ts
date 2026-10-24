/** Minimal 3D vector math for hand geometry (image axes: x right, y down, z away from camera). */
export interface Vec3 {
  x: number
  y: number
  z: number
}

export const vec = (x: number, y: number, z = 0): Vec3 => ({ x, y, z })
export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z)
export const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z)
export const scale = (a: Vec3, k: number): Vec3 => vec(a.x * k, a.y * k, a.z * k)
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b))

/** Angle between two vectors in degrees (0 when either is degenerate). */
export function angleDeg(a: Vec3, b: Vec3): number {
  const n = length(a) * length(b)
  if (n < 1e-9) return 0
  return (Math.acos(Math.min(1, Math.max(-1, dot(a, b) / n))) * 180) / Math.PI
}

/** Linear 0..1 ramp: 0 at or below `from`, 1 at or above `to`. */
export function ramp(value: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (value - from) / (to - from)))
}
