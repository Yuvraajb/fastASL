import type { Landmark } from '@shared/types'
import type { FrameSample, HandSample } from '../types'

/**
 * Hand-motion energy (0..1) for the activity bars: mean landmark speed in hand
 * sizes per second, minus a jitter floor, soft-clipped with tanh and smoothed
 * with a time-based EMA so it behaves the same at 15 or 30 fps.
 */
export interface MotionOptions {
  /** Source width / height. Landmark x and y are normalized separately, so x is scaled by this. */
  aspect: number
  /** Speeds below this (hand sizes / s) are tracking jitter. */
  noiseFloor: number
  /** Speed above the floor that maps to tanh(1) ≈ 0.76. */
  fullScale: number
  /** EMA time constant (ms). */
  smoothingMs: number
}

export const MOTION_DEFAULTS: MotionOptions = { aspect: 1, noiseFloor: 0.3, fullScale: 3, smoothingMs: 150 }

export interface MotionState {
  energy: number
  last: FrameSample | null
}

export const INITIAL_MOTION: MotionState = { energy: 0, last: null }

// MediaPipe hand landmark indices.
const WRIST = 0
const INDEX_MCP = 5
const MIDDLE_MCP = 9
const PINKY_MCP = 17
/** Shortest interval used for speed, so back-to-back duplicate frames don't read as a jolt. */
const MIN_DT_MS = 8
/** Wrists further apart than this (in hand sizes) belong to different hands. */
const MAX_MATCH_DISTANCE = 3

function dist(a: Landmark, b: Landmark, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y)
}

/** Palm size; the larger of two palm spans so it stays stable when the hand turns. */
export function handSize(landmarks: Landmark[], aspect = 1): number {
  return Math.max(
    dist(landmarks[WRIST], landmarks[MIDDLE_MCP], aspect),
    dist(landmarks[INDEX_MCP], landmarks[PINKY_MCP], aspect),
    1e-3
  )
}

/** Mean displacement of corresponding landmarks, in hand sizes. */
function handDisplacement(a: HandSample, b: HandSample, aspect: number): number {
  const n = Math.min(a.landmarks.length, b.landmarks.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += dist(a.landmarks[i], b.landmarks[i], aspect)
  return sum / n / handSize(b.landmarks, aspect)
}

/**
 * Fastest hand's mean landmark speed between two frames, in hand sizes per second.
 * Hands are paired by nearest wrist (handedness labels can flicker); hands that
 * appear or vanish contribute nothing.
 */
export function frameSpeed(prev: FrameSample, next: FrameSample, aspect = 1): number {
  const dtSec = Math.max(next.t - prev.t, MIN_DT_MS) / 1000
  const unused = new Set(prev.hands)
  let fastest = 0
  for (const hand of next.hands) {
    const size = handSize(hand.landmarks, aspect)
    let match: HandSample | null = null
    let best = MAX_MATCH_DISTANCE
    for (const candidate of unused) {
      const d = dist(candidate.landmarks[WRIST], hand.landmarks[WRIST], aspect) / size
      if (d < best) {
        best = d
        match = candidate
      }
    }
    if (!match) continue
    unused.delete(match)
    fastest = Math.max(fastest, handDisplacement(match, hand, aspect) / dtSec)
  }
  return fastest
}

/** Advance the motion state by one frame. Pure: returns a new state. */
export function stepMotion(state: MotionState, frame: FrameSample, options: Partial<MotionOptions> = {}): MotionState {
  const { aspect, noiseFloor, fullScale, smoothingMs } = { ...MOTION_DEFAULTS, ...options }
  const prev = state.last
  if (!prev || frame.t <= prev.t) return { energy: state.energy, last: frame }
  const speed = frameSpeed(prev, frame, aspect)
  const target = Math.tanh(Math.max(0, speed - noiseFloor) / fullScale)
  const alpha = 1 - Math.exp(-(frame.t - prev.t) / smoothingMs)
  return { energy: state.energy + alpha * (target - state.energy), last: frame }
}
