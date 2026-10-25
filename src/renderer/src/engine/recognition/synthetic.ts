import type { Handedness, Landmark } from '@shared/types'
import type { FrameSample, HandSample } from '../types'

/*
 * Synthetic MediaPipe-like hands for tests and threshold calibration (never used at runtime).
 *
 * A kinematic hand with realistic proportions (wrist -> middle MCP = 1 "hand length"),
 * per-finger curl, spread and thumb pose, rotated in 3D and projected into normalized
 * image coordinates the way HandLandmarker reports them (x, y in 0..1; z relative to the
 * wrist on the x scale). Performances add the rep-to-rep variation of a real signer:
 * tempo, amplitude, timing warp, hand size/position, orientation, finger curl, landmark
 * jitter, frame-time jitter and dropped frames.
 */

type Vec3 = [number, number, number]

/** Deterministic PRNG (mulberry32), so every synthetic test is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

/** Uniform in [-1, 1]. */
const jitter = (random: () => number): number => random() * 2 - 1

export interface Handshape {
  /** Index, middle, ring, pinky: 0 = straight, 1 = fully curled. */
  curls: [number, number, number, number]
  /** Finger spread multiplier (0 = together, 1 = relaxed, 2 = wide). */
  spread: number
  /** Thumb abduction: 0 = alongside the index, 1 = out to the side. */
  thumbOut: number
  /** Thumb flexion across the palm: 0 = straight, 1 = tucked. */
  thumbFlex: number
  /** Bend the middle/end knuckles only (E, X), not the base knuckles. */
  hook?: boolean
}

export const SHAPES = {
  B: { curls: [0, 0, 0, 0], spread: 0.2, thumbOut: 0.1, thumbFlex: 0.7 },
  FIVE: { curls: [0, 0, 0, 0], spread: 2, thumbOut: 1, thumbFlex: 0 },
  A: { curls: [1, 1, 1, 1], spread: 0.2, thumbOut: 0.25, thumbFlex: 0 },
  S: { curls: [1, 1, 1, 1], spread: 0.2, thumbOut: 0.2, thumbFlex: 0.9 },
  E: { curls: [0.9, 0.9, 0.9, 0.9], spread: 0.2, thumbOut: 0, thumbFlex: 1, hook: true },
  C: { curls: [0.45, 0.45, 0.45, 0.45], spread: 0.3, thumbOut: 0.6, thumbFlex: 0.35 },
  O: { curls: [0.65, 0.65, 0.65, 0.65], spread: 0.3, thumbOut: 0.4, thumbFlex: 0.6 },
  D: { curls: [0, 0.7, 0.7, 0.7], spread: 0.3, thumbOut: 0.4, thumbFlex: 0.6 },
  ONE: { curls: [0, 1, 1, 1], spread: 0.3, thumbOut: 0.2, thumbFlex: 0.9 },
  L: { curls: [0, 1, 1, 1], spread: 0.3, thumbOut: 1, thumbFlex: 0 },
  V: { curls: [0, 0, 1, 1], spread: 1.8, thumbOut: 0.2, thumbFlex: 0.9 },
  W: { curls: [0, 0, 0, 1], spread: 1.6, thumbOut: 0.2, thumbFlex: 0.9 },
  I: { curls: [1, 1, 1, 0], spread: 0.3, thumbOut: 0.2, thumbFlex: 0.9 },
  Y: { curls: [1, 1, 1, 0], spread: 1, thumbOut: 1, thumbFlex: 0 },
  CLAW: { curls: [0.5, 0.5, 0.5, 0.5], spread: 1.8, thumbOut: 0.9, thumbFlex: 0.2 }
} satisfies Record<string, Handshape>

export type ShapeName = keyof typeof SHAPES

/** Finger geometry in the palm plane: MCP (side, up) and phalanx lengths, hand-length units. */
const FINGERS = [
  { mcp: [0.3, 0.92], lengths: [0.45, 0.27, 0.22], spread: 9 },
  { mcp: [0.08, 0.997], lengths: [0.5, 0.31, 0.24], spread: 0 },
  { mcp: [-0.13, 0.94], lengths: [0.47, 0.29, 0.23], spread: -7 },
  { mcp: [-0.32, 0.83], lengths: [0.36, 0.22, 0.2], spread: -14 }
] as const
const FINGER_FLEX = [85, 100, 70]
const HOOK_FLEX = [15, 110, 80]
const THUMB_BASE = [0.22, 0.28] as const
const THUMB_LENGTHS = [0.42, 0.33, 0.28]
const THUMB_FLEX = [25, 55, 75]

const rad = (deg: number): number => (deg * Math.PI) / 180
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const norm = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a))
/** cos(θ)·a + sin(θ)·b */
const turn = (a: Vec3, b: Vec3, deg: number): Vec3 => add(scale(a, Math.cos(rad(deg))), b, Math.sin(rad(deg)))

/**
 * The 21 landmarks in hand units and camera axes (x right, y down, z away from the camera),
 * for an upright hand with the palm facing the camera, before any rotation.
 */
function handPoints(shape: Handshape, handedness: Handedness): Vec3[] {
  const side: Vec3 = [handedness === 'Right' ? 1 : -1, 0, 0] // toward the thumb
  const up: Vec3 = [0, -1, 0] // toward the fingertips
  const palm: Vec3 = [0, 0, -1] // the way the palm faces
  const at = (s: number, u: number): Vec3 => add(scale(side, s), up, u)
  const points: Vec3[] = [[0, 0, 0]]

  const thumbDir = norm(add(turn(up, side, 25 + shape.thumbOut * 45), palm, 0.3))
  const across = norm(add(scale(side, -1), palm, 0.8))
  let p = at(THUMB_BASE[0], THUMB_BASE[1])
  points.push(p)
  let flex = 0
  THUMB_LENGTHS.forEach((length, k) => {
    flex += THUMB_FLEX[k] * shape.thumbFlex
    p = add(p, norm(turn(thumbDir, across, flex)), length)
    points.push(p)
  })

  FINGERS.forEach((finger, f) => {
    const dir = turn(up, side, finger.spread * shape.spread)
    let q = at(finger.mcp[0], finger.mcp[1])
    points.push(q)
    let bend = 0
    finger.lengths.forEach((length, k) => {
      bend += (shape.hook ? HOOK_FLEX : FINGER_FLEX)[k] * shape.curls[f]
      q = add(q, turn(dir, palm, bend), length)
      points.push(q)
    })
  })
  return points
}

export interface HandPose {
  shape: Handshape
  handedness: Handedness
  /** Wrist position in normalized image coordinates. */
  x: number
  y: number
  /** Wrist -> middle-MCP length as a fraction of the image height. */
  size: number
  /** Degrees: roll in the image plane, pitch about x, yaw about y. */
  roll: number
  pitch: number
  yaw: number
}

function rotate(v: Vec3, roll: number, pitch: number, yaw: number): Vec3 {
  const [cx, sx] = [Math.cos(rad(pitch)), Math.sin(rad(pitch))]
  const [cy, sy] = [Math.cos(rad(yaw)), Math.sin(rad(yaw))]
  const [cz, sz] = [Math.cos(rad(roll)), Math.sin(rad(roll))]
  let [x, y, z] = v
  ;[y, z] = [y * cx - z * sx, y * sx + z * cx]
  ;[x, z] = [x * cy + z * sy, -x * sy + z * cy]
  ;[x, y] = [x * cz - y * sz, x * sz + y * cz]
  return [x, y, z]
}

/** Project a posed hand to MediaPipe normalized landmarks for an image of the given aspect. */
export function poseLandmarks(pose: HandPose, aspect: number): Landmark[] {
  return handPoints(pose.shape, pose.handedness).map((local) => {
    const [x, y, z] = rotate(local, pose.roll, pose.pitch, pose.yaw)
    return {
      x: (pose.x * aspect + x * pose.size) / aspect,
      y: pose.y + y * pose.size,
      z: (z * pose.size) / aspect
    }
  })
}

function lerpShape(a: Handshape, b: Handshape, k: number): Handshape {
  const mix = (x: number, y: number): number => x + (y - x) * k
  return {
    curls: a.curls.map((c, i) => mix(c, b.curls[i])) as Handshape['curls'],
    spread: mix(a.spread, b.spread),
    thumbOut: mix(a.thumbOut, b.thumbOut),
    thumbFlex: mix(a.thumbFlex, b.thumbFlex),
    hook: k < 0.5 ? a.hook : b.hook
  }
}

// ---------------------------------------------------------------------------------------------
// Performances

/** One hand's part in a sign. Paths are in hand lengths, over normalized time u in [0, 1]. */
export interface HandMotion {
  handedness: Handedness
  shape: ShapeName
  /** Handshape at the end of the sign (morphs linearly), e.g. for opening/closing signs. */
  endShape?: ShapeName
  /** Wrist offset from the hand's start position. Must be [0, 0] at u = 0. */
  path: (u: number) => [number, number]
  /** Orientation (degrees) over time. */
  roll?: (u: number) => number
  pitch?: (u: number) => number
  yaw?: (u: number) => number
  /** Start offset from the signing position, in hand lengths (e.g. two hands apart). */
  offset?: [number, number]
}

export interface SignSpec {
  hands: HandMotion[]
  durationMs: number
}

export interface PerformOptions {
  random: () => number
  /** 0 = perfect copy, 1 = a real signer's rep-to-rep variation. */
  variation?: number
  /** Landmark jitter (normalized image units, ~1.5 px at 640 px per 0.0025). */
  noise?: number
  fps?: number
  aspect?: number
  /** Still time before the sign starts / after it ends. */
  restBeforeMs?: number
  restAfterMs?: number
  /** Fraction of frames where tracking drops every hand. */
  dropout?: number
  /** Start timestamp. */
  t0?: number
  /** Signing position (wrist, normalized image coordinates) instead of the default near the middle. */
  center?: [number, number]
  /** Wrist -> middle-MCP length as a fraction of the image height, before variation. */
  handSize?: number
  /** The hands first rise into view from below the frame over this long (0 = already up). */
  raiseMs?: number
  /** At the end the hands drop out of view over this long. */
  lowerMs?: number
}

const smoothstep = (u: number): number => u * u * (3 - 2 * u)

const DEFAULT_HAND_SIZE = 0.17
/** Hands whose wrist is this far below the frame are not tracked. */
const LOST_BELOW = 1.05

/** 1 = out of view below the frame, 0 = at the signing position (smooth in between). */
function offscreen(t: number, raiseMs: number, lowerFrom: number, lowerMs: number): number {
  if (t < raiseMs) return 1 - smoothstep(t / raiseMs)
  return lowerMs > 0 && t > lowerFrom ? smoothstep(Math.min(1, (t - lowerFrom) / lowerMs)) : 0
}

/** Hand lengths to move a hand at height y down until it is out of view. */
const dropLength = (y: number, size: number): number => (LOST_BELOW + 0.05 - y) / size

const tracked = (hand: HandSample): boolean => hand.landmarks[0].y <= LOST_BELOW

/** Render one repetition of a sign as a FrameSample stream (rest, motion, rest). */
export function performSign(spec: SignSpec, opts: PerformOptions): FrameSample[] {
  const r = opts.random
  const v = opts.variation ?? 1
  const aspect = opts.aspect ?? 4 / 3
  const noise = opts.noise ?? 0.0025
  const fps = opts.fps ?? 30
  const duration = spec.durationMs * (1 + 0.2 * v * jitter(r))
  const amplitude = 1 + 0.15 * v * jitter(r)
  const warp = 0.12 * v * jitter(r)
  const size = (opts.handSize ?? DEFAULT_HAND_SIZE) * (1 + 0.2 * v * jitter(r))
  const center: [number, number] = opts.center ?? [0.5 + 0.08 * v * jitter(r), 0.55 + 0.06 * v * jitter(r)]
  const tilt = { roll: 8 * v * jitter(r), pitch: 8 * v * jitter(r), yaw: 8 * v * jitter(r) }
  const curlJitter = spec.hands.map(() => [0, 1, 2, 3].map(() => 0.06 * v * jitter(r)))

  const before = opts.restBeforeMs ?? 300
  const after = opts.restAfterMs ?? 700
  const raise = opts.raiseMs ?? 0
  const lower = opts.lowerMs ?? 0
  const total = raise + before + duration + after + lower
  const drop = dropLength(center[1], size)
  const frames: FrameSample[] = []
  let t = 0
  while (t <= total) {
    const raw = Math.min(1, Math.max(0, (t - raise - before) / duration))
    const down = drop * offscreen(t, raise, total - lower, lower)
    const u = smoothstep(Math.min(1, Math.max(0, raw + warp * Math.sin(Math.PI * raw))))
    const hands: HandSample[] = spec.hands.map((motion, h) => {
      const base = lerpShape(SHAPES[motion.shape], SHAPES[motion.endShape ?? motion.shape], u)
      const shape = { ...base, curls: base.curls.map((c, i) => clamp01(c + curlJitter[h][i])) as Handshape['curls'] }
      const [dx, dy] = motion.path(u)
      const [ox, oy] = motion.offset ?? [0, 0]
      const pose: HandPose = {
        shape,
        handedness: motion.handedness,
        x: center[0] + ((ox + dx * amplitude) * size) / aspect,
        y: center[1] + (oy + dy * amplitude + down) * size,
        size,
        roll: tilt.roll + (motion.roll?.(u) ?? 0),
        pitch: tilt.pitch + (motion.pitch?.(u) ?? 0),
        yaw: tilt.yaw + (motion.yaw?.(u) ?? 0)
      }
      return { handedness: motion.handedness, score: 0.95, landmarks: addNoise(poseLandmarks(pose, aspect), noise, r) }
    })
    frames.push({ t: (opts.t0 ?? 0) + t, hands: r() < (opts.dropout ?? 0.02) ? [] : hands.filter(tracked) })
    t += (1000 / fps) * (1 + 0.1 * jitter(r))
  }
  return frames
}

export interface HoldStep {
  shape: ShapeName
  holdMs: number
  /** Wrist offset in hand lengths (moving between steps slides the hand). */
  at?: [number, number]
}

/**
 * A static fingerspelling sequence: each step holds a shape, with `transitionMs` of
 * morphing (and sliding, if `at` changes) in between. `raiseMs` / `lowerMs` bring the hand
 * up into view in the first shape and drop it out of view in the last.
 */
export function performHolds(
  steps: HoldStep[],
  opts: PerformOptions & { handedness?: Handedness; transitionMs?: number }
): FrameSample[] {
  const r = opts.random
  const v = opts.variation ?? 1
  const aspect = opts.aspect ?? 4 / 3
  const fps = opts.fps ?? 30
  const transition = opts.transitionMs ?? 250
  const size = (opts.handSize ?? DEFAULT_HAND_SIZE) * (1 + 0.2 * v * jitter(r))
  const center: [number, number] = [0.5 + 0.08 * v * jitter(r), 0.5 + 0.06 * v * jitter(r)]
  const handedness = opts.handedness ?? 'Right'
  const raise = opts.raiseMs ?? 0
  const lower = opts.lowerMs ?? 0
  const spans = steps.map((step, i) => (i === 0 ? raise : transition) + step.holdMs + (i === steps.length - 1 ? lower : 0))
  const total = spans.reduce((a, b) => a + b, 0)
  const drop = dropLength(center[1], size)
  const frames: FrameSample[] = []
  let start = 0
  let t = 0 // one frame clock across steps
  steps.forEach((step, i) => {
    const prev = steps[i - 1] ?? step
    const tilt = { roll: 8 * v * jitter(r), pitch: 8 * v * jitter(r), yaw: 8 * v * jitter(r) }
    const curls = [0, 1, 2, 3].map(() => 0.06 * v * jitter(r))
    const span = spans[i]
    for (; t < start + span; t += (1000 / fps) * (1 + 0.1 * jitter(r))) {
      const local = t - start
      const k = i === 0 ? 1 : smoothstep(Math.min(1, local / transition))
      const base = lerpShape(SHAPES[prev.shape], SHAPES[step.shape], k)
      const shape = { ...base, curls: base.curls.map((c, j) => clamp01(c + curls[j])) as Handshape['curls'] }
      const [ax, ay] = prev.at ?? [0, 0]
      const [bx, by] = step.at ?? [0, 0]
      const pose: HandPose = {
        shape,
        handedness,
        x: center[0] + ((ax + (bx - ax) * k) * size) / aspect,
        y: center[1] + (ay + (by - ay) * k + drop * offscreen(t, raise, total - lower, lower)) * size,
        size,
        ...tilt
      }
      const hand: HandSample = { handedness, score: 0.95, landmarks: addNoise(poseLandmarks(pose, aspect), opts.noise ?? 0.0025, r) }
      frames.push({ t: (opts.t0 ?? 0) + t, hands: r() < (opts.dropout ?? 0) ? [] : [hand].filter(tracked) })
    }
    start += span
  })
  return frames
}

/** Empty frames (no hands), e.g. between repetitions. */
export function emptyFrames(fromT: number, ms: number, fps = 30): FrameSample[] {
  const frames: FrameSample[] = []
  for (let t = 0; t < ms; t += 1000 / fps) frames.push({ t: fromT + t, hands: [] })
  return frames
}

/** Performances on one clock, with the hands down for `gapMs` after each. */
export function timeline(parts: ((t0: number) => FrameSample[])[], gapMs = 300): FrameSample[] {
  const out: FrameSample[] = []
  let t = 0
  for (const make of parts) {
    const frames = make(t)
    const gap = emptyFrames(frames[frames.length - 1].t + 33, gapMs)
    out.push(...frames, ...gap)
    t = gap[gap.length - 1].t + 33
  }
  return out
}

function addNoise(points: Landmark[], sigma: number, r: () => number): Landmark[] {
  return points.map((p) => ({
    x: p.x + sigma * gaussian(r),
    y: p.y + sigma * gaussian(r),
    z: p.z + 2 * sigma * gaussian(r)
  }))
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

// ---------------------------------------------------------------------------------------------
// A small synthetic vocabulary with distinct movements, handshapes and one/two hands.

const right = 'Right' as const
const left = 'Left' as const
const wave = (u: number, cycles: number): number => Math.sin(2 * Math.PI * cycles * u)

export const WORDS: Record<string, SignSpec> = {
  HELLO: {
    durationMs: 700,
    hands: [{ handedness: right, shape: 'B', roll: () => -10, path: (u) => [-3 * u, -0.4 * Math.sin(Math.PI * u)] }]
  },
  YES: {
    durationMs: 900,
    hands: [{ handedness: right, shape: 'S', path: (u) => [0, 0.7 * Math.abs(wave(u, 1))], pitch: (u) => 25 * Math.abs(wave(u, 1)) }]
  },
  PLAY: {
    durationMs: 1000,
    hands: [{ handedness: right, shape: 'Y', path: (u) => [1.2 * (Math.cos(2 * Math.PI * u) - 1), 1.2 * Math.sin(2 * Math.PI * u)] }]
  },
  NO: {
    durationMs: 600,
    hands: [{ handedness: right, shape: 'V', endShape: 'O', path: (u) => [0, 1.2 * u], pitch: (u) => 20 * u }]
  },
  MUSIC: {
    durationMs: 1100,
    hands: [{ handedness: right, shape: 'B', roll: () => 60, path: (u) => [1.4 * wave(u, 1.5), 0.2 * Math.abs(wave(u, 1.5))] }]
  },
  MEETING: {
    durationMs: 800,
    hands: [
      { handedness: right, shape: 'FIVE', endShape: 'O', offset: [-1.8, 0], path: (u) => [1.4 * u, 0] },
      { handedness: left, shape: 'FIVE', endShape: 'O', offset: [1.8, 0], path: (u) => [-1.4 * u, 0] }
    ]
  },
  TOMORROW: {
    durationMs: 700,
    hands: [{ handedness: right, shape: 'A', roll: () => -20, path: (u) => [-1.5 * u, 1.2 * u] }]
  },
  SEND: {
    durationMs: 600,
    hands: [{ handedness: right, shape: 'E', endShape: 'FIVE', path: (u) => [0, -2 * u], pitch: (u) => 40 * u }]
  },
  FRIEND: {
    durationMs: 900,
    hands: [
      { handedness: right, shape: 'ONE', roll: () => 80, offset: [0, -0.3], path: (u) => [0, 0.6 * wave(u, 1)] },
      { handedness: left, shape: 'ONE', roll: () => -80, offset: [0, 0.3], path: (u) => [0, -0.6 * wave(u, 1)] }
    ]
  },
  TIME: {
    durationMs: 500,
    hands: [{ handedness: right, shape: 'D', roll: () => 30, path: (u) => [0, 0.5 * Math.abs(wave(u, 1))] }]
  }
}

/** Movements that are not in the vocabulary (should be rejected). */
export const UNKNOWN: Record<string, SignSpec> = {
  zigzag: {
    durationMs: 900,
    hands: [{ handedness: right, shape: 'L', path: (u) => [2.5 * u, 0.8 * wave(u, 2)] }]
  },
  reverseCircle: {
    durationMs: 1000,
    hands: [{ handedness: right, shape: 'W', path: (u) => [1.2 * (Math.cos(2 * Math.PI * u) - 1), -1.2 * Math.sin(2 * Math.PI * u)] }]
  },
  scratch: {
    durationMs: 700,
    hands: [{ handedness: right, shape: 'CLAW', pitch: () => 30, path: (u) => [0.25 * wave(u, 4), 0.15 * wave(u, 8)] }]
  },
  reach: {
    durationMs: 800,
    hands: [{ handedness: right, shape: 'C', roll: () => 45, path: (u) => [2 * u, 2 * u] }]
  },
  twoHandSwing: {
    durationMs: 900,
    hands: [
      { handedness: right, shape: 'S', offset: [-1.5, 0], path: (u) => [0, 1.5 * wave(u, 1)] },
      { handedness: left, shape: 'S', offset: [1.5, 0], path: (u) => [0, 1.5 * wave(u, 1)] }
    ]
  }
}

/** Letters the synthetic hand can make (static, one hand). */
export const LETTER_SHAPES = ['A', 'B', 'C', 'D', 'E', 'I', 'L', 'O', 'S', 'V', 'W', 'Y'] as const
