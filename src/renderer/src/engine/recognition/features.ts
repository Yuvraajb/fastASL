import type { Handedness } from '@shared/types'
import type { HandSample } from '../types'

/*
 * Feature vectors for sign recognition.
 *
 * Everything is hand-relative: landmarks are centered on the wrist and scaled by the
 * wrist -> middle-MCP distance, and hand velocity is measured in hand lengths per second.
 * Nothing depends on where the hand sits in the image or on the face/body, so the same
 * features keep working from a head-mounted camera.
 *
 * `aspect` (image width / height) converts MediaPipe's normalized x/z (fractions of the
 * width) and y (fraction of the height) into one unit, so a hand keeps its true proportions
 * on a 16:9 camera. Pass the same aspect when recording and recognizing.
 */

const LANDMARK_COUNT = 21
const WRIST = 0
const MIDDLE_MCP = 9
/**
 * Wrist and the four finger knuckles. Their mean is the hand's position: it has a fraction of
 * one landmark's jitter and does not move when the fingers do.
 */
const PALM = [WRIST, 5, MIDDLE_MCP, 13, 17]

/** Hand slots of a frame vector. Slotting by handedness keeps two-handed signs aligned. */
export const SLOTS: readonly Handedness[] = ['Right', 'Left']

/** Single-hand handshape: 21 x (x, y, z). */
export const STATIC_FEATURE_DIM = LANDMARK_COUNT * 3
/** Per slot: presence, 21 x (x, y, z), handedness, vx, vy. */
export const HAND_FEATURE_DIM = 1 + STATIC_FEATURE_DIM + 1 + 2
/** Per frame: both slots. */
export const FRAME_FEATURE_DIM = HAND_FEATURE_DIM * SLOTS.length

const PRESENCE = 0
const POINTS = 1
const HANDEDNESS = POINTS + STATIC_FEATURE_DIM
const VELOCITY = HANDEDNESS + 1

/** MediaPipe's z is its noisiest axis, so it counts half in distances. */
const Z_WEIGHT = 0.5
/** Velocity weight inside frame vectors, so motion and handshape both matter to DTW. */
const VELOCITY_WEIGHT = 0.3
/** Speed clamp (hand lengths / s). */
const MAX_SPEED = 20
/**
 * A jump longer than this (hand lengths) that is also faster than MAX_SPEED is a tracking
 * glitch or two hands trading slots, not motion: it gives no velocity.
 */
const MAX_JUMP = 1.5
/** A previous frame older than this gives no velocity (camera stall, hand re-acquired). */
const MAX_VELOCITY_GAP_MS = 250

/** One hand measured in hand units. */
export interface HandMeasure {
  /** 21 x (x, y, z), wrist at the origin, wrist -> middle MCP = 1, z weighted. */
  points: number[]
  /** Palm center in aspect-corrected image units (fractions of the image height). */
  x: number
  y: number
  /** Wrist -> middle-MCP distance in the same units. */
  scale: number
}

/** A frame's hands by slot (see slotHands). */
export interface SlottedFrame {
  t: number
  hands: (HandSample | null)[]
}

export function measureHand(hand: HandSample, aspect = 1): HandMeasure | null {
  const lm = hand.landmarks
  if (lm.length !== LANDMARK_COUNT) return null
  const w = lm[WRIST]
  const m = lm[MIDDLE_MCP]
  const scale = Math.hypot((m.x - w.x) * aspect, m.y - w.y, (m.z - w.z) * aspect)
  if (!(scale > 1e-6)) return null
  const points = new Array<number>(STATIC_FEATURE_DIM)
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    points[i * 3] = ((lm[i].x - w.x) * aspect) / scale
    points[i * 3 + 1] = (lm[i].y - w.y) / scale
    points[i * 3 + 2] = ((lm[i].z - w.z) * aspect * Z_WEIGHT) / scale
  }
  const x = (PALM.reduce((sum, i) => sum + lm[i].x, 0) / PALM.length) * aspect
  const y = PALM.reduce((sum, i) => sum + lm[i].y, 0) / PALM.length
  return { points, x, y, scale }
}

/**
 * Static handshape vector (letters, custom shapes). Left hands are mirrored onto right-hand
 * geometry, so a shape recorded with one hand matches the same shape made with the other.
 */
export function staticFeatures(hand: HandSample, aspect = 1): number[] | null {
  const m = measureHand(hand, aspect)
  return m && mirrorIfLeft(m.points, hand.handedness)
}

export function mirrorIfLeft(points: number[], handedness: Handedness): number[] {
  return handedness === 'Left' ? points.map((v, i) => (i % 3 === 0 ? -v : v)) : points
}

/**
 * Hands by slot: each hand goes to its handedness slot. When MediaPipe gives both hands the
 * same label, each keeps the slot of the nearest hand in `previous` (the slots of the last
 * frame with hands), so the two do not trade places from frame to frame; with no previous
 * hands, the more confident one keeps its label's slot.
 */
export function slotHands(hands: readonly HandSample[], previous: readonly (HandSample | null)[] = []): (HandSample | null)[] {
  const ranked = [...hands].sort((a, b) => b.score - a.score).slice(0, SLOTS.length)
  if (ranked.length === 2 && ranked[0].handedness === ranked[1].handedness) {
    const [a, b] = ranked
    const byScore = SLOTS.indexOf(a.handedness) === 0 ? [a, b] : [b, a]
    const swapped = [byScore[1], byScore[0]]
    return travel(swapped, previous) < travel(byScore, previous) ? swapped : byScore
  }
  const slots: (HandSample | null)[] = SLOTS.map(() => null)
  for (const hand of ranked) slots[SLOTS.indexOf(hand.handedness)] = hand
  return slots
}

/** Total wrist distance from each slot's previous hand (normalized image units). */
function travel(slots: readonly HandSample[], previous: readonly (HandSample | null)[]): number {
  return slots.reduce((sum, hand, i) => {
    const [now, was] = [hand.landmarks[WRIST], previous[i]?.landmarks[WRIST]]
    return was ? sum + Math.hypot(now.x - was.x, now.y - was.y) : sum
  }, 0)
}

/** Per-frame vector for dynamic signs; a missing hand is zero-filled. */
export function frameFeatures(frame: SlottedFrame, prev: SlottedFrame | null, aspect = 1): number[] {
  const out = new Array<number>(FRAME_FEATURE_DIM).fill(0)
  const dtMs = prev ? frame.t - prev.t : 0
  const before = prev && dtMs > 0 && dtMs <= MAX_VELOCITY_GAP_MS ? prev.hands : null
  frame.hands.forEach((hand, slot) => {
    const cur = hand && measureHand(hand, aspect)
    if (!hand || !cur) return
    const base = slot * HAND_FEATURE_DIM
    out[base + PRESENCE] = 1
    for (let i = 0; i < STATIC_FEATURE_DIM; i++) out[base + POINTS + i] = cur.points[i]
    out[base + HANDEDNESS] = hand.handedness === 'Right' ? 1 : -1
    const prevHand = before?.[slot]
    const was = prevHand && measureHand(prevHand, aspect)
    if (!was) return
    const [dx, dy] = [(cur.x - was.x) / cur.scale, (cur.y - was.y) / cur.scale]
    const perSecond = 1000 / dtMs
    const jump = Math.hypot(dx, dy)
    if (jump > MAX_JUMP && jump * perSecond > MAX_SPEED) return
    out[base + VELOCITY] = clampSpeed(dx * perSecond) * VELOCITY_WEIGHT
    out[base + VELOCITY + 1] = clampSpeed(dy * perSecond) * VELOCITY_WEIGHT
  })
  return out
}

function clampSpeed(v: number): number {
  return Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v))
}

export function slotPresent(features: readonly number[], slot: number): boolean {
  return features[slot * HAND_FEATURE_DIM + PRESENCE] === 1
}

/** Hand velocity of a slot in hand lengths per second (unweighted). */
export function slotVelocity(features: readonly number[], slot: number): [number, number] {
  const base = slot * HAND_FEATURE_DIM + VELOCITY
  return [features[base] / VELOCITY_WEIGHT, features[base + 1] / VELOCITY_WEIGHT]
}

/** Hand slots present in at least half of a sequence's frames (both when neither is). */
export function usedSlots(frames: readonly (readonly number[])[]): number[] {
  const used = SLOTS.map((_, slot) => slot).filter(
    (slot) => frames.filter((f) => slotPresent(f, slot)).length * 2 >= frames.length
  )
  return used.length ? used : SLOTS.map((_, slot) => slot)
}

/** Each frame cut down to the given hand slots (in order), for comparing only those hands. */
export function selectSlots(frames: readonly (readonly number[])[], slots: readonly number[]): number[][] {
  return frames.map((f) => slots.flatMap((slot) => f.slice(slot * HAND_FEATURE_DIM, (slot + 1) * HAND_FEATURE_DIM)))
}

/**
 * A one-handed sign recorded with the other hand also in view: keeps the signing hand and
 * empties the other slot, so recognition doesn't expect a second hand next time. The signing
 * hand is `dominant` (the slot the user's other one-handed signs use) when it was seen in at
 * least half the frames, else the hand that moved more: the other hand can move a lot too, while
 * it is lowered or raised.
 */
export function keepActiveHand(frames: readonly (readonly number[])[], dominant: number | null = null): number[][] {
  const energy = slotEnergy(frames)
  const keep = dominant !== null && usedSlots(frames).includes(dominant) ? dominant : energy[0] >= energy[1] ? 0 : 1
  const drop = 1 - keep
  const [from, to] = [drop * HAND_FEATURE_DIM, (drop + 1) * HAND_FEATURE_DIM]
  return frames.map((f) => f.map((v, i) => (i >= from && i < to ? 0 : v)))
}

/** Per slot: the hand's speed summed over the frames it was seen in (how much it moved). */
export function slotEnergy(frames: readonly (readonly number[])[]): number[] {
  return SLOTS.map((_, slot) =>
    frames.reduce((sum, f) => (slotPresent(f, slot) ? sum + Math.hypot(...slotVelocity(f, slot)) : sum), 0)
  )
}

/**
 * The slot the user signs one-handed words with: the one most of their one-handed word templates
 * use (null with none). That hand is the dominant one, whichever label MediaPipe gives it.
 */
export function dominantSlot(templates: readonly { kind: string; frames: readonly (readonly number[])[] }[]): number | null {
  const count = SLOTS.map(() => 0)
  for (const t of templates) {
    if (t.kind !== 'word' || !t.frames.length || t.frames[0].length !== FRAME_FEATURE_DIM) continue
    const used = usedSlots(t.frames)
    if (used.length === 1) count[used[0]]++
  }
  if (count[0] === count[1]) return null
  return count[0] > count[1] ? 0 : 1
}

