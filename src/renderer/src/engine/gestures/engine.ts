/**
 * GestureEngine: hands-only control gestures from a stream of MediaPipe frames.
 * Pure and deterministic. Feed it every frame (including frames with no hands);
 * it returns the GestureInputs that fired on that frame.
 *
 * Gestures (base values at medium sensitivity; hold times and the hands-down
 * delay scale with holdScale, swipe distance and speed with swipeScale):
 *
 *   palmHold    open palm: 5 digits extended, hand upright, palm plane facing the camera   1.0 s
 *   fingers{n}  1 index | 2 index+middle | 3 index+middle+ring or ASL 3 | 4 thumb folded | 5 open palm   0.8 s
 *   thumbsUp    fingers curled, thumb straight, pointing up, tip clearly above the knuckles   0.5 s
 *   fist        fingers curled, thumb not pointing up (so ASL A is not a fist)          0.9 s
 *   shape{id}   custom matcher hit, else the built-in V / peace ('builtin-peace')        0.8 s
 *   handsDown   no hands for 1.2 s after hands were visible; once until they come back
 *   swipeLeft/Right  wrist travels ≥ 0.22 frame widths within 300 ms, peak speed ≥ 1.2 widths/s
 *                    (over ≥ 60 ms), horizontal travel > 2.2 × vertical
 *   swipeUp     same upward: ≥ 0.20 frame heights, peak ≥ 1.2 heights/s
 *
 * Mirroring: landmarks are raw camera coordinates but the user watches a mirrored
 * preview. Moving the hand toward the left of that preview (the user's own left) is
 * +x in the raw frame, so +x is swipeLeft and -x is swipeRight.
 *
 * Keeping ordinary signing from triggering controls:
 *  - Static gestures need a hold. Signs change handshape every ~150-400 ms; a control
 *    shape must stay the same for 0.5-1.0 s.
 *  - Holds also need every visible hand to be still (wrist < 0.8 palm lengths/s over
 *    200 ms). A passive base hand (an S hand under a moving dominant hand) never
 *    completes a fist, and a hold never fires on a moving frame.
 *  - Shape rules are strict and return nothing when unsure: ASL A, a relaxed hand, a C,
 *    or a half-tucked thumb (2 vs ASL 3) produce no control.
 *  - Swipes need a long, fast, straight stroke by a flat hand (≥ 3 fingers mostly
 *    straight in at least half of the window) while any other visible hand is at rest.
 *    Signing movements are shorter, slower or two-handed. Only motion after the hand
 *    was first seen at rest counts, so raising a hand into view is not a stroke.
 *  - Each stroke is decided once: when it is detected it either fires or is discarded,
 *    and the rest of it is ignored until the hands come to rest, so a discarded stroke
 *    cannot fire later when a lockout or cooldown runs out.
 *  - Flicker: 1-2 frames of a different reading (or a dropped hand) do not reset a
 *    hold; the 3rd consecutive frame does.
 *  - Refractory: 700 ms of silence after any event; the same gesture (same count /
 *    shape id) cannot refire for 1.5 s; the opposite horizontal swipe is ignored until
 *    1.2 s after the swipe's motion ended (return stroke). A swipe that interrupts a hold
 *    that is at least 60% done is discarded.
 *  - Release: a fired hold must be released (no hand shows it for 300 ms, so a tracking
 *    dropout or a brief misread is not a release) before it can start again. The same
 *    applies to the shapes a swiping hand showed (no "swipe, pause, pick 5") and, through
 *    spendShown(), to whatever is held when the view changes: every new view needs a
 *    fresh gesture.
 *  - Only gestures in the active set (activeGestures(view)) are evaluated, fired or
 *    reported in progress().
 */
import type { GestureInput, GestureName } from '../../app/controller'
import { SENSITIVITY, type FrameSample, type HandSample, type SensitivityProfile } from '../types'
import {
  analyzeHand,
  fingerCount,
  isFist,
  isFlatHand,
  isOpenPalm,
  isPeace,
  isThumbsUp,
  LANDMARK_COUNT,
  WRIST,
  type HandShape
} from './handShape'
import { detectSwipe, HandTracks, STILL_SPEED, SWIPE, wristSpeed, type SwipeGesture, type Track } from './motion'

export const BUILTIN_PEACE_ID = 'builtin-peace'

type HoldGesture = 'palmHold' | 'fingers' | 'thumbsUp' | 'fist' | 'shape'

/** Base hold times in ms (× holdScale). */
export const HOLD_MS: Record<HoldGesture, number> = {
  palmHold: 1000,
  fingers: 800,
  thumbsUp: 500,
  fist: 900,
  shape: 800
}
export const HANDS_DOWN_MS = 1200
export const REFRACTORY_MS = 700
export const REPEAT_MS = 1500
export const SWIPE_RETURN_MS = 1200
/** Consecutive disagreeing frames tolerated before a hold resets. */
export const FLICKER_FRAMES = 2
/** A spent gesture is released once no hand has shown it for this long (longer than a tracking dropout). */
export const RELEASE_MS = 300
/** A swipe is discarded while a hold is at least this far along. */
const HOLD_GUARD = 0.6

const ALL_GESTURES: readonly GestureName[] = [
  'palmHold',
  'swipeLeft',
  'swipeRight',
  'swipeUp',
  'thumbsUp',
  'fist',
  'fingers',
  'handsDown',
  'shape'
]
const SWIPES: readonly SwipeGesture[] = ['swipeLeft', 'swipeRight', 'swipeUp']
const OPPOSITE: Partial<Record<SwipeGesture, SwipeGesture>> = { swipeLeft: 'swipeRight', swipeRight: 'swipeLeft' }

/** Custom static shape lookup. Called per hand per frame while 'shape' is active or a custom shape is spent. */
export type ShapeMatcher = (hand: HandSample) => { id: string } | null

export interface GestureProgress {
  /** 0..1 progress of the open-palm hold. */
  palmHold: number
  pick: { count: number; progress: number } | null
  shape: { id: string; progress: number } | null
}

export interface GestureEngineOptions {
  sensitivity?: SensitivityProfile
  /** Source width / height (landmark x is a fraction of width). Default 1. */
  aspect?: number
}

interface Reading {
  hand: HandSample
  shape: HandShape
  track: Track
  /** Every control gesture this hand currently shows, ignoring the active set, by priority. */
  inputs: GestureInput[]
}

interface HoldState {
  /** Stable (flicker-filtered) candidate and when it started. */
  key: string | null
  input: GestureInput | null
  since: number
  /** Consecutive frames whose candidate differs from `key`. */
  mismatch: number
  /** Current run of identical per-frame candidates. */
  runKey: string | null
  runSince: number
}

interface EngineState {
  now: number
  tracks: HandTracks
  hold: HoldState
  movingRun: number
  /** Holds count from here: the last frame of sustained movement. */
  stillSince: number
  /** When each gesture key was last shown by any hand, active or not. */
  seen: Map<string, number>
  /** Keys that must be released (unseen for RELEASE_MS) before they can hold again. */
  spent: Set<string>
  lastEventAt: number
  lastFired: Map<string, number>
  /** Last fired swipe; t is when its motion ended (the return-stroke lockout counts from there). */
  lastSwipe: { gesture: SwipeGesture; t: number } | null
  /** Swipe windows ignore samples before this (strokes already used or discarded). */
  swipeFrom: number
  /** The current stroke was already fired or discarded: its motion is ignored until the hands rest. */
  stroke: 'fired' | 'discarded' | null
  presentRun: number
  lastHandAt: number
  handsDownArmed: boolean
}

const emptyHold = (): HoldState => ({ key: null, input: null, since: 0, mismatch: 0, runKey: null, runSince: 0 })

function initialState(): EngineState {
  return {
    now: 0,
    tracks: new HandTracks(),
    hold: emptyHold(),
    movingRun: 0,
    stillSince: -Infinity,
    seen: new Map(),
    spent: new Set(),
    lastEventAt: -Infinity,
    lastFired: new Map(),
    lastSwipe: null,
    swipeFrom: -Infinity,
    stroke: null,
    presentRun: 0,
    lastHandAt: -Infinity,
    handsDownArmed: false
  }
}

/** Identity used for holds and repeat cooldowns: fingers and shapes include their parameter. */
export function gestureKey(input: GestureInput): string {
  if (input.gesture === 'fingers') return `fingers:${input.count}`
  if (input.gesture === 'shape') return `shape:${input.shapeId}`
  return input.gesture
}

export class GestureEngine {
  private active = new Set<GestureName>(ALL_GESTURES)
  private sensitivity: SensitivityProfile
  private aspect: number
  private matcher: ShapeMatcher | null = null
  private s = initialState()

  constructor(opts: GestureEngineOptions = {}) {
    this.sensitivity = opts.sensitivity ?? SENSITIVITY.medium
    this.aspect = opts.aspect ?? 1
  }

  /** Gestures allowed in the current view (default: all). Idempotent; call on every view change. */
  setActive(gestures: Set<GestureName>): void {
    // handsDown needs hands to be seen while it is active, so entering a view with
    // the hands already down does not fire it immediately.
    if (gestures.has('handsDown') && !this.active.has('handsDown')) this.s.handsDownArmed = false
    this.active = new Set(gestures)
    const held = this.s.hold.input
    if (held && !this.active.has(held.gesture)) this.s.hold = emptyHold()
  }

  setSensitivity(profile: SensitivityProfile): void {
    this.sensitivity = profile
  }

  /** Source width / height; call when the camera source changes. */
  setAspect(aspect: number): void {
    this.aspect = aspect
  }

  setShapeMatcher(fn: ShapeMatcher | null): void {
    this.matcher = fn
  }

  /** Forget all motion, holds and cooldowns (keeps active set, sensitivity, aspect, matcher). */
  reset(): void {
    this.s = initialState()
  }

  /**
   * Every gesture shown now (or just before a dropout) must be released before it can hold
   * again. Call when the view changes meaning, so a hand already up when a view appears
   * (a thumbs-up kept up while Claude thinks) can't act in it without a fresh gesture.
   */
  spendShown(): void {
    const { seen, spent, now } = this.s
    for (const [key, t] of seen) if (now - t < RELEASE_MS) spent.add(key)
  }

  update(frame: FrameSample): GestureInput[] {
    this.s.now = frame.t
    const readings = this.read(frame)
    const moving = readings.some((r) => wristSpeed(r.track) > STILL_SPEED)
    if (!moving) this.s.movingRun = 0
    else if (++this.s.movingRun > FLICKER_FRAMES) this.s.stillSince = frame.t

    this.updateSeen(readings)
    const fired = [this.handsDown(readings.length > 0), this.swipe(readings, moving), this.holdStep(readings, moving)]
    return fired.filter((input): input is GestureInput => input !== null)
  }

  progress(): GestureProgress {
    const p = this.holdFraction()
    const input = p > 0 ? this.s.hold.input : null
    return {
      palmHold: input?.gesture === 'palmHold' ? p : 0,
      pick: input?.gesture === 'fingers' && input.count ? { count: input.count, progress: p } : null,
      shape: input?.gesture === 'shape' && input.shapeId ? { id: input.shapeId, progress: p } : null
    }
  }

  private read(frame: FrameSample): Reading[] {
    const hands = frame.hands.filter((h) => h.landmarks.length >= LANDMARK_COUNT)
    const shapes = hands.map((h) => analyzeHand(h, this.aspect))
    const tracks = this.s.tracks.update(
      hands.map((h, i) => ({
        t: frame.t,
        x: h.landmarks[WRIST].x * this.aspect,
        y: h.landmarks[WRIST].y,
        palm: shapes[i].palmSize,
        flat: isFlatHand(shapes[i])
      })),
      frame.t
    )
    return hands.map((hand, i) => ({ hand, shape: shapes[i], track: tracks[i], inputs: this.inputsFor(hand, shapes[i]) }))
  }

  private inputsFor(hand: HandSample, shape: HandShape): GestureInput[] {
    const inputs: GestureInput[] = []
    if (isThumbsUp(shape)) inputs.push({ gesture: 'thumbsUp' })
    if (isFist(shape)) inputs.push({ gesture: 'fist' })
    if (isOpenPalm(shape)) inputs.push({ gesture: 'palmHold' })
    const count = fingerCount(shape)
    if (count) inputs.push({ gesture: 'fingers', count })
    // A spent custom shape must stay recognized while 'shape' is gated off, or it would be
    // released mid-hold and refire when the view allows shapes again.
    const wantCustom = this.active.has('shape') || [...this.s.spent].some((k) => k.startsWith('shape:'))
    const custom = this.matcher && wantCustom ? this.matcher(hand) : null
    if (custom) inputs.push({ gesture: 'shape', shapeId: custom.id })
    if (isPeace(shape)) inputs.push({ gesture: 'shape', shapeId: BUILTIN_PEACE_ID })
    return inputs
  }

  /** Records what each hand shows; a spent key is released once no hand has shown it for RELEASE_MS. */
  private updateSeen(readings: Reading[]): void {
    const { seen, spent, now } = this.s
    for (const r of readings) for (const input of r.inputs) seen.set(gestureKey(input), now)
    for (const key of spent) if (now - (seen.get(key) ?? -Infinity) >= RELEASE_MS) spent.delete(key)
  }

  private handsDown(present: boolean): GestureInput | null {
    const s = this.s
    if (present) {
      s.lastHandAt = s.now
      if (++s.presentRun > FLICKER_FRAMES) s.handsDownArmed = true
      return null
    }
    s.presentRun = 0
    if (!s.handsDownArmed || !this.active.has('handsDown')) return null
    if (s.now - s.lastHandAt < HANDS_DOWN_MS * this.sensitivity.holdScale) return null
    const input: GestureInput = { gesture: 'handsDown' }
    if (!this.tryFire(input)) return null
    s.handsDownArmed = false
    return input
  }

  private swipe(readings: Reading[], moving: boolean): GestureInput | null {
    const s = this.s
    // A decided stroke is consumed until the hands rest, so it can't be detected again later.
    if (s.stroke) {
      if (moving) {
        s.swipeFrom = s.now
        if (s.stroke === 'fired' && s.lastSwipe) s.lastSwipe.t = s.now
        return null
      }
      s.stroke = null
    }
    if (!SWIPES.some((g) => this.active.has(g))) return null
    const from = Math.max(s.now - SWIPE.windowMs, s.swipeFrom)
    for (const r of readings) {
      const gesture = detectSwipe(r.track, from, this.sensitivity.swipeScale, this.aspect)
      if (!gesture) continue
      s.stroke = 'discarded'
      s.swipeFrom = s.now
      const input: GestureInput = { gesture }
      if (!this.swipeAllowed(gesture, r, readings) || !this.tryFire(input)) return null
      s.stroke = 'fired'
      s.lastSwipe = { gesture, t: s.now }
      // The swiping hand's follow-through (same flat hand, now still) must not start a hold.
      for (const i of r.inputs) s.spent.add(gestureKey(i))
      return input
    }
    return null
  }

  private swipeAllowed(gesture: SwipeGesture, swiping: Reading, readings: Reading[]): boolean {
    const { lastSwipe, now } = this.s
    const returning = lastSwipe && OPPOSITE[gesture] === lastSwipe.gesture && now - lastSwipe.t < SWIPE_RETURN_MS
    return (
      this.active.has(gesture) &&
      !returning &&
      !readings.some((o) => o !== swiping && wristSpeed(o.track) > STILL_SPEED) &&
      this.holdFraction() < HOLD_GUARD
    )
  }

  private holdStep(readings: Reading[], moving: boolean): GestureInput | null {
    const s = this.s
    const h = s.hold
    const candidate = this.candidate(readings)
    const key = candidate ? gestureKey(candidate) : null
    if (key !== h.runKey) {
      h.runKey = key
      h.runSince = s.now
    }
    if (key === h.key) {
      h.mismatch = 0
    } else if (++h.mismatch > FLICKER_FRAMES) {
      Object.assign(h, { key, input: candidate, since: h.runSince, mismatch: 0 })
    }

    const input = h.input
    if (moving || !input || key !== h.key || this.holdFraction() < 1 || !this.tryFire(input)) return null
    s.spent.add(gestureKey(input))
    return input
  }

  /** This frame's hold candidate: keep following the current hold, else the largest hand. */
  private candidate(readings: Reading[]): GestureInput | null {
    let best: GestureInput | null = null
    let bestSize = 0
    for (const r of readings) {
      const input = r.inputs.find((i) => this.active.has(i.gesture))
      if (!input) continue
      if (gestureKey(input) === this.s.hold.key) return input
      if (r.shape.palmSize > bestSize) {
        best = input
        bestSize = r.shape.palmSize
      }
    }
    return best
  }

  private holdFraction(): number {
    const { hold, spent, now, stillSince } = this.s
    if (!hold.input || spent.has(gestureKey(hold.input))) return 0
    const ms = HOLD_MS[hold.input.gesture as HoldGesture] * this.sensitivity.holdScale
    return Math.min(1, Math.max(0, (now - Math.max(hold.since, stillSince)) / ms))
  }

  private tryFire(input: GestureInput): boolean {
    const s = this.s
    const key = gestureKey(input)
    if (s.now - s.lastEventAt < REFRACTORY_MS) return false
    if (s.now - (s.lastFired.get(key) ?? -Infinity) < REPEAT_MS) return false
    s.lastEventAt = s.now
    s.lastFired.set(key, s.now)
    return true
  }
}
