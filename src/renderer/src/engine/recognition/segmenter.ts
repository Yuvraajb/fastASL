import type { Handedness } from '@shared/types'
import type { FrameSample, HandSample } from '../types'
import { euclidean } from './dtw'
import { frameFeatures, measureHand, mirrorIfLeft, SLOTS, slotHands, slotVelocity, type SlottedFrame } from './features'

/** Speeds are hand speeds in hand lengths per second; times in ms. */
export interface SegmenterThresholds {
  /** The wrist must be this far inside the image edges (normalized) to count as signing. */
  zoneMargin: number
  /** Smoothed hand speed that starts a dynamic sign. */
  startSpeed: number
  /** Below this the hands count as still (hysteresis under startSpeed). */
  stopSpeed: number
  /** Stillness that ends a sign. */
  stillMs: number
  /** Time without a hand in the zone that ends a sign (tolerates tracking dropouts). */
  leaveMs: number
  /** A movement starting this soon after the hands come into view is flagged `entered`. */
  entryMs: number
  /** Frames kept from before the start trigger, so the sign's onset is not cut. */
  preRollMs: number
  /** Still frames kept after the last movement. */
  tailMs: number
  /** Shorter segments (pre-roll and tail included) are noise: emitted as cancel 'too-short'. */
  minSignMs: number
  /** Longer motion is not one sign: emitted as cancel 'too-long'. */
  maxSignMs: number
  /**
   * Time constant of the hand-velocity smoothing. Smoothing the vector (not the speed) lets
   * jitter cancel out; a time constant keeps it the same at 15, 30 or 60 fps and stops a
   * burst of closely spaced frames from turning jitter into speed.
   */
  velocitySmoothingMs: number
  /** How long one hand must hold a stable shape to emit a static (fingerspelling) segment. */
  staticHoldMs: number
  /**
   * Max drift of the shape over the hold window: the distance between the mean shapes of its
   * two halves. Averaging keeps landmark jitter (large on small hands) out of it.
   */
  staticDrift: number
  /** Time constant of the shape smoothing used to notice a shape change (re-arm). */
  shapeSmoothingMs: number
  /** After a static emit, the shape must move this far (static-vector distance) to re-arm... */
  rearmShape: number
  /** ...or the hand must travel this many hand lengths (a slide or dip for double letters). */
  rearmMove: number
}

/** Calibrated on synthetic hands with MediaPipe-like jitter (see recognizer.ts). */
export const DEFAULT_THRESHOLDS: SegmenterThresholds = {
  zoneMargin: 0.03,
  startSpeed: 1.8,
  stopSpeed: 1.1,
  stillMs: 400,
  leaveMs: 200,
  entryMs: 250,
  preRollMs: 100,
  tailMs: 100,
  minSignMs: 350,
  maxSignMs: 4000,
  velocitySmoothingMs: 65,
  staticHoldMs: 500,
  staticDrift: 0.3,
  shapeSmoothingMs: 100,
  rearmShape: 0.9,
  rearmMove: 0.5
}

/**
 * How a movement began and ended. `entered`: it started as the hands came into view (raising
 * them). `left`: it ended with the hands leaving view (lowering them) rather than holding still.
 */
export interface MovementEdges {
  entered: boolean
  left: boolean
}

export type Segment =
  | { kind: 'start'; t: number }
  | ({ kind: 'dynamic'; frames: FrameSample[]; features: number[][]; durationMs: number } & MovementEdges)
  | { kind: 'static'; features: number[]; handedness: Handedness; t: number }
  | ({ kind: 'cancel'; reason: 'too-short' | 'too-long' } & MovementEdges)

interface Entry {
  frame: FrameSample
  features: number[]
}

/**
 * Streaming segmentation of the hand-tracking feed.
 *
 * Dynamic: a sign starts when a hand in the signing zone moves faster than startSpeed
 * (emits 'start'), and ends after stillMs of stillness or when the hands leave (emits
 * 'dynamic', or 'cancel' when too short / too long). Every 'start' gets exactly one of the two.
 *
 * Static: one hand holding a stable shape for staticHoldMs emits 'static' with the mean
 * shape vector. It then needs a shape change, a slide/dip, or the hand leaving before the
 * next one, so a held letter is emitted once and double letters work. A static never comes
 * on the frame a movement ends, so the caller can still blockStatic() if it was a word.
 */
export class Segmenter {
  private th: SegmenterThresholds
  private aspect = 1
  private prev: SlottedFrame | null = null
  /** Slots of the last frame with hands, so same-labeled hands keep their places. */
  private lastSlots: (HandSample | null)[] = []
  /** Smoothed hand velocity per slot. */
  private velocity = SLOTS.map((): [number, number] => [0, 0])
  private speed = 0
  private phase: 'idle' | 'active' | 'cooldown' = 'idle'
  /** Pre-roll while idle, the segment while active. */
  private entries: Entry[] = []
  private startT = 0
  private lastMoveT = 0
  private lastHandT = -Infinity
  /** When the hands last came into view after being gone. */
  private enteredT = -Infinity
  private entered = false

  private hold: { t: number; vec: number[] }[] = []
  private holdStart = 0
  private holdHand: Handedness | null = null
  /** Low-jitter running shape of the single hand in view. */
  private shape: { vec: number[]; hand: Handedness; t: number } | null = null
  private isArmed = true
  /** Last emitted (or blocking) shape and where the hand was; null = take the next one seen. */
  private ref: { vec: number[]; hand: Handedness; x: number; y: number } | null = null

  constructor(thresholds: Partial<SegmenterThresholds> = {}, aspect = 1) {
    this.th = { ...DEFAULT_THRESHOLDS, ...thresholds }
    this.setAspect(aspect)
  }

  get thresholds(): Readonly<SegmenterThresholds> {
    return this.th
  }

  /** False from a static until the shape changes, the hand slides or dips, or it leaves. */
  get armed(): boolean {
    return this.isArmed
  }

  setThresholds(patch: Partial<SegmenterThresholds>): void {
    this.th = { ...this.th, ...patch }
  }

  /** Image width / height of the camera feed. Ignored unless finite and positive (an unsized feed gives 0/0). */
  setAspect(aspect: number): void {
    if (!(Number.isFinite(aspect) && aspect > 0) || aspect === this.aspect) return
    this.aspect = aspect
    this.prev = null // no velocity across the change
  }

  /** Drop any segment in progress; the next static needs a fresh shape or the hand to leave. */
  reset(): void {
    this.prev = null
    this.velocity = SLOTS.map((): [number, number] => [0, 0])
    this.speed = 0
    this.phase = 'idle'
    this.entries = []
    this.blockStatic()
  }

  /**
   * The shape held now is not a letter (e.g. the last shape of a recognized word): no static
   * until it changes, the hand slides or dips, or it leaves.
   */
  blockStatic(): void {
    this.isArmed = false
    this.ref = null
    this.hold = []
  }

  push(frame: FrameSample): Segment[] {
    const out: Segment[] = []
    const slotted: SlottedFrame = { t: frame.t, hands: slotHands(frame.hands, this.lastSlots) }
    if (frame.hands.length > 0) this.lastSlots = slotted.hands
    const features = frameFeatures(slotted, this.prev, this.aspect)
    const dt = this.prev ? frame.t - this.prev.t : Infinity
    const alpha = dt > 0 ? 1 - Math.exp(-dt / this.th.velocitySmoothingMs) : 0
    this.prev = slotted

    let present = false
    this.speed = 0
    slotted.hands.forEach((hand, slot) => {
      const inZone = hand !== null && this.inZone(hand)
      const [vx, vy] = inZone ? slotVelocity(features, slot) : [0, 0]
      const v = this.velocity[slot]
      v[0] += alpha * (vx - v[0])
      v[1] += alpha * (vy - v[1])
      if (!inZone) return
      present = true
      this.speed = Math.max(this.speed, Math.hypot(v[0], v[1]))
    })
    if (present) {
      if (frame.t - this.lastHandT >= this.th.leaveMs) this.enteredT = frame.t
      this.lastHandT = frame.t
    }

    this.trackDynamic({ frame, features }, present, out)
    this.trackStatic(frame, out)
    return out
  }

  private inZone(hand: HandSample): boolean {
    const { x, y } = hand.landmarks[0]
    const m = this.th.zoneMargin
    return x >= m && x <= 1 - m && y >= m && y <= 1 - m
  }

  private trackDynamic(entry: Entry, present: boolean, out: Segment[]): void {
    const { t } = entry.frame
    const th = this.th
    if (this.phase === 'idle') {
      if (present) this.entries.push(entry)
      this.entries = this.entries.filter((e) => e.frame.t >= t - th.preRollMs)
      if (present && this.speed > th.startSpeed) {
        this.phase = 'active'
        this.startT = this.entries[0].frame.t
        this.lastMoveT = t
        this.entered = t - this.enteredT <= th.entryMs
        out.push({ kind: 'start', t })
      }
      return
    }

    if (this.phase === 'active' && present) this.entries.push(entry)
    if (this.speed > th.stopSpeed) this.lastMoveT = t
    const left = t - this.lastHandT >= th.leaveMs
    const ended = left || t - this.lastMoveT >= th.stillMs
    if (this.phase === 'cooldown') {
      if (ended) this.phase = 'idle'
    } else if (ended) {
      out.push(this.finish(left))
    } else if (t - this.startT > th.maxSignMs) {
      out.push({ kind: 'cancel', reason: 'too-long', entered: this.entered, left: false })
      this.phase = 'cooldown'
      this.entries = []
    }
  }

  private finish(left: boolean): Segment {
    const end = this.lastMoveT + this.th.tailMs
    const kept = this.entries.filter((e) => e.frame.t <= end)
    this.entries = []
    this.phase = 'idle'
    const edges = { entered: this.entered, left }
    const durationMs = kept.length > 1 ? kept[kept.length - 1].frame.t - kept[0].frame.t : 0
    if (durationMs < this.th.minSignMs) return { kind: 'cancel', reason: 'too-short', ...edges }
    return { kind: 'dynamic', frames: kept.map((e) => e.frame), features: kept.map((e) => e.features), durationMs, ...edges }
  }

  private trackStatic(frame: FrameSample, out: Segment[]): void {
    const { t } = frame
    const th = this.th
    if (frame.hands.length === 0) {
      // A dropped frame or two keeps the hold; a hand gone for leaveMs re-arms.
      if (t - this.lastHandT >= th.leaveMs) {
        this.hold = []
        this.shape = null
        this.isArmed = true
      }
      return
    }
    const hand = frame.hands.length === 1 && this.inZone(frame.hands[0]) ? frame.hands[0] : null
    const m = hand && measureHand(hand, this.aspect)
    if (!hand || !m) {
      this.hold = []
      this.shape = null
      return
    }
    const vec = mirrorIfLeft(m.points, hand.handedness)
    const shape = this.smoothShape(vec, hand.handedness, t)

    // Re-arming runs during motion too, so a dip between double letters counts. The hold
    // starts over on re-arm: the next letter needs its own staticHoldMs of stability. Shapes
    // are only compared under the same handedness label, so a one-frame label flip (which
    // mirrors the vector) does not re-arm.
    if (!this.isArmed) {
      if (!this.ref) this.ref = { vec: shape, hand: hand.handedness, x: m.x, y: m.y }
      else if (
        (hand.handedness === this.ref.hand && euclidean(shape, this.ref.vec) > th.rearmShape) ||
        Math.hypot(m.x - this.ref.x, m.y - this.ref.y) / m.scale > th.rearmMove
      ) {
        this.isArmed = true
        this.hold = []
      }
    }

    if (this.hold.length === 0 || hand.handedness !== this.holdHand) {
      this.hold = []
      this.holdHand = hand.handedness
      this.holdStart = t
    }
    this.hold.push({ t, vec })
    while (this.hold[0].t < t - th.staticHoldMs) this.hold.shift()
    // A hold builds up during motion too (the shape is hand-relative) but only emits once the
    // hands are still, so a letter right after a slide does not wait another staticHoldMs. It
    // never emits on the frame a movement ends, so the caller can blockStatic() a word's end.
    if (this.phase !== 'idle' || out.length > 0 || !this.isArmed || t - this.holdStart < th.staticHoldMs) return

    const vectors = this.hold.map((h) => h.vec)
    const half = Math.floor(vectors.length / 2)
    if (half === 0 || euclidean(meanVector(vectors.slice(0, half)), meanVector(vectors.slice(half))) > th.staticDrift) return

    const mean = meanVector(vectors)
    out.push({ kind: 'static', features: mean, handedness: hand.handedness, t })
    this.isArmed = false
    this.ref = { vec: mean, hand: hand.handedness, x: m.x, y: m.y }
  }

  private smoothShape(vec: number[], hand: Handedness, t: number): number[] {
    const s = this.shape
    if (!s || s.hand !== hand) {
      this.shape = { vec, hand, t }
      return vec
    }
    const k = 1 - Math.exp(-(t - s.t) / this.th.shapeSmoothingMs)
    s.vec = s.vec.map((v, i) => v + k * (vec[i] - v))
    s.t = t
    return s.vec
  }
}

function meanVector(vectors: readonly (readonly number[])[]): number[] {
  const mean = new Array<number>(vectors[0].length).fill(0)
  for (const v of vectors) for (let i = 0; i < mean.length; i++) mean[i] += v[i] / vectors.length
  return mean
}
