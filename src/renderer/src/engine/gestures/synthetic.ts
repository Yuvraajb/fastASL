import type { Handedness } from '@shared/types'
import type { FrameSample, HandSample } from '../types'
import { CHAIN, FINGERS, type Finger } from './handShape'
import { add, scale, vec, type Vec3 } from './vec'

/**
 * Synthetic MediaPipe-style hands for tests and dev tooling.
 *
 * A pose is built in a local hand frame (palm length = 1) with forward kinematics:
 * s = toward the thumb, u = up the palm, n = out of the palm. Fingers flex from
 * their MCP toward n. The hand is then placed in the image: palm facing the camera
 * (n → -z), fingers up (u → -y), thumb on image +x for a right hand (that is how
 * a subject's right palm appears in an un-mirrored frame), then rotated, scaled,
 * translated and jittered. Output landmarks are normalized and NOT mirrored, like
 * MediaPipe's.
 */

export type PoseName =
  | 'openPalm'
  | 'five'
  | 'fist'
  | 'thumbsUp'
  | 'one'
  | 'peace'
  | 'twoTogether'
  | 'three'
  | 'threeAsl'
  | 'four'
  | 'relaxed'
  | 'aslA'
  | 'aslC'

type Flex = [mcp: number, pip: number, dip: number]
type ThumbPoints = [mcp: Vec3, ip: Vec3, tip: Vec3]

interface PoseDef {
  flex: Record<Finger, Flex>
  /** Finger abduction in degrees, positive toward the thumb. */
  splay: Record<Finger, number>
  thumb: ThumbPoints
  /** In-plane roll applied in the hand frame (thumbs-up is built with the thumb out sideways). */
  roll?: number
}

const MCP: Record<Finger, Vec3> = {
  index: vec(0.3, 0.95),
  middle: vec(0, 1),
  ring: vec(-0.24, 0.95),
  pinky: vec(-0.45, 0.84)
}
const SEGMENTS: Record<Finger, Flex> = {
  index: [0.4, 0.25, 0.2],
  middle: [0.44, 0.27, 0.21],
  ring: [0.41, 0.26, 0.19],
  pinky: [0.32, 0.2, 0.16]
}
const THUMB_CMC = vec(0.2, 0.15)

const STRAIGHT: Flex = [0, 5, 3]
const CURLED: Flex = [85, 100, 65]
const RELAXED: Flex = [25, 50, 30]
const CURVED: Flex = [35, 50, 25]

/** Thumb MCP, IP and tip in (s, u, n) hand coordinates. */
const THUMB = {
  out: [vec(0.46, 0.4, 0.05), vec(0.68, 0.56, 0.07), vec(0.88, 0.7, 0.08)],
  acrossPalm: [vec(0.36, 0.38, 0.12), vec(0.2, 0.55, 0.22), vec(0, 0.62, 0.22)],
  overFingers: [vec(0.4, 0.42, 0.18), vec(0.3, 0.65, 0.4), vec(0.08, 0.78, 0.47)],
  alongside: [vec(0.42, 0.45, 0.1), vec(0.44, 0.75, 0.14), vec(0.44, 0.98, 0.15)],
  sideways: [vec(0.48, 0.3, 0.08), vec(0.76, 0.32, 0.12), vec(1, 0.33, 0.14)],
  loose: [vec(0.42, 0.4, 0.1), vec(0.56, 0.6, 0.16), vec(0.62, 0.78, 0.2)],
  cupped: [vec(0.42, 0.4, 0.15), vec(0.52, 0.62, 0.32), vec(0.5, 0.8, 0.45)]
} satisfies Record<string, ThumbPoints>

const all = (flex: Flex): Record<Finger, Flex> => ({ index: flex, middle: flex, ring: flex, pinky: flex })
const fingers = (index: Flex, middle: Flex, ring: Flex, pinky: Flex): Record<Finger, Flex> => ({
  index,
  middle,
  ring,
  pinky
})
const splay = (index: number, middle: number, ring: number, pinky: number): Record<Finger, number> => ({
  index,
  middle,
  ring,
  pinky
})
const CLOSED = splay(3, 0, -3, -6)

const POSES: Record<PoseName, PoseDef> = {
  openPalm: { flex: all(STRAIGHT), splay: splay(6, 0, -6, -12), thumb: THUMB.out },
  five: { flex: all(STRAIGHT), splay: splay(14, 2, -10, -22), thumb: THUMB.out },
  fist: { flex: all(CURLED), splay: CLOSED, thumb: THUMB.overFingers },
  thumbsUp: { flex: all(CURLED), splay: CLOSED, thumb: THUMB.sideways, roll: 90 },
  one: { flex: fingers(STRAIGHT, CURLED, CURLED, CURLED), splay: CLOSED, thumb: THUMB.overFingers },
  peace: { flex: fingers(STRAIGHT, STRAIGHT, CURLED, CURLED), splay: splay(12, -10, -3, -6), thumb: THUMB.overFingers },
  twoTogether: { flex: fingers(STRAIGHT, STRAIGHT, CURLED, CURLED), splay: CLOSED, thumb: THUMB.overFingers },
  three: { flex: fingers(STRAIGHT, STRAIGHT, STRAIGHT, CURLED), splay: splay(10, 0, -10, -6), thumb: THUMB.overFingers },
  threeAsl: { flex: fingers(STRAIGHT, STRAIGHT, CURLED, CURLED), splay: splay(12, -6, -3, -6), thumb: THUMB.out },
  four: { flex: all(STRAIGHT), splay: splay(8, 2, -5, -12), thumb: THUMB.acrossPalm },
  relaxed: { flex: all(RELAXED), splay: splay(5, 0, -5, -10), thumb: THUMB.loose },
  aslA: { flex: all(CURLED), splay: CLOSED, thumb: THUMB.alongside },
  aslC: { flex: all(CURVED), splay: CLOSED, thumb: THUMB.cupped }
}

const rad = (deg: number): number => (deg * Math.PI) / 180

/** Pose landmarks in (s, u, n) hand coordinates, wrist at the origin, palm length 1. */
function localLandmarks(def: PoseDef): Vec3[] {
  const points: Vec3[] = new Array(21)
  points[0] = vec(0, 0)
  points[CHAIN.thumb[0]] = THUMB_CMC
  def.thumb.forEach((p, i) => (points[CHAIN.thumb[i + 1]] = p))
  for (const f of FINGERS) {
    const a = rad(def.splay[f])
    const base = vec(Math.sin(a), Math.cos(a))
    let joint = MCP[f]
    let bend = 0
    points[CHAIN[f][0]] = joint
    for (let k = 0; k < 3; k++) {
      bend += rad(def.flex[f][k])
      const dir = add(scale(base, Math.cos(bend)), vec(0, 0, Math.sin(bend)))
      joint = add(joint, scale(dir, SEGMENTS[f][k]))
      points[CHAIN[f][k + 1]] = joint
    }
  }
  if (!def.roll) return points
  const r = rad(def.roll)
  return points.map((p) => vec(p.x * Math.cos(r) - p.y * Math.sin(r), p.x * Math.sin(r) + p.y * Math.cos(r), p.z))
}

/** Rotate about image z (roll), then y (yaw: turns the palm sideways), then x (pitch). Degrees. */
function rotate(p: Vec3, roll: number, yaw: number, pitch: number): Vec3 {
  const [cr, sr, cy, sy, cp, sp] = [roll, yaw, pitch].flatMap((d) => [Math.cos(rad(d)), Math.sin(rad(d))])
  const a = vec(p.x * cr - p.y * sr, p.x * sr + p.y * cr, p.z)
  const b = vec(a.x * cy + a.z * sy, a.y, -a.x * sy + a.z * cy)
  return vec(b.x, b.y * cp - b.z * sp, b.y * sp + b.z * cp)
}

export interface HandSpec {
  pose: PoseName
  handedness?: Handedness
  /** Wrist position in normalized image coordinates (default 0.5, 0.75). */
  x?: number
  y?: number
  /** Palm length (wrist → middle MCP) as a fraction of frame height (default 0.18). */
  size?: number
  /** Degrees: roll in the image plane (+ = clockwise on screen), yaw about vertical, pitch about horizontal. */
  roll?: number
  yaw?: number
  pitch?: number
  /** Landmark jitter σ in normalized units (default 0). */
  noise?: number
}

export interface SynthOptions {
  /** Source width / height (default 1). */
  aspect?: number
  /** Uniform [0, 1) random source, used for noise. */
  rng?: () => number
}

/** Seeded uniform PRNG (mulberry32), so noisy tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng())
}

/** One synthetic hand with 21 landmarks. */
export function makeHand(spec: HandSpec, { aspect = 1, rng = Math.random }: SynthOptions = {}): HandSample {
  const { pose, handedness = 'Right', x = 0.5, y = 0.75, size = 0.18, roll = 0, yaw = 0, pitch = 0, noise = 0 } = spec
  const side = handedness === 'Right' ? 1 : -1
  const jitter = (): number => (noise ? gaussian(rng) * noise : 0)
  const landmarks = localLandmarks(POSES[pose]).map((p) => {
    const image = rotate(vec(side * p.x, -p.y, -p.z), roll, yaw, pitch)
    // Isotropic units → normalized: x and z are fractions of frame width.
    return {
      x: (x * aspect + image.x * size) / aspect + jitter(),
      y: y + image.y * size + jitter(),
      z: (image.z * size) / aspect + jitter()
    }
  })
  return { landmarks, handedness, score: 0.95 }
}

/** Smoothstep easing: minimum-jerk-like velocity profile, peak speed 1.5× the average. */
export const easeInOut = (u: number): number => u * u * (3 - 2 * u)

export interface TimelineOptions {
  fps?: number
  /** Timestamp of the first frame (ms). */
  t0?: number
  seed?: number
  aspect?: number
}

/**
 * Builds a FrameSample stream at a fixed frame rate. Each segment covers `ms`
 * and receives the progress `u` in [0, 1) of every frame it emits.
 */
export class Timeline {
  readonly frames: FrameSample[] = []
  private readonly t0: number
  private readonly dt: number
  private readonly synth: SynthOptions

  constructor({ fps = 30, t0 = 1000, seed = 1, aspect = 1 }: TimelineOptions = {}) {
    this.t0 = t0
    this.dt = 1000 / fps
    this.synth = { aspect, rng: seededRandom(seed) }
  }

  /** Time of the next frame to be emitted. */
  get now(): number {
    return this.t0 + this.frames.length * this.dt
  }

  segment(ms: number, hands: (u: number) => HandSpec[]): this {
    const n = Math.max(1, Math.round(ms / this.dt))
    for (let i = 0; i < n; i++) {
      this.frames.push({ t: this.now, hands: hands(i / n).map((h) => makeHand(h, this.synth)) })
    }
    return this
  }

  /** Hands held in place. */
  hold(ms: number, ...hands: HandSpec[]): this {
    return this.segment(ms, () => hands)
  }

  /** One hand moving from its spec position to `to` with smoothstep easing; ends exactly at `to`. */
  move(ms: number, hand: HandSpec, to: { x?: number; y?: number }): this {
    const x0 = hand.x ?? 0.5
    const y0 = hand.y ?? 0.75
    const x1 = to.x ?? x0
    const y1 = to.y ?? y0
    const n = Math.max(1, Math.round(ms / this.dt))
    return this.segment(ms, (u) => {
      const e = easeInOut(Math.min(1, u + 1 / n))
      return [{ ...hand, x: x0 + (x1 - x0) * e, y: y0 + (y1 - y0) * e }]
    })
  }

  /** No hands in view. */
  none(ms: number): this {
    return this.segment(ms, () => [])
  }
}
