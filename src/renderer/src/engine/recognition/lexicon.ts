import type { Dictionary, FingerRule, HandshapeDef, LocationDef, MovementDef, SignDef } from '@shared/dictionary'
import { analyzeHand, FINGERS, type HandShape } from '../gestures/handShape'
import type { FaceBox, FrameSample, HandSample } from '../types'
import { measureHand } from './features'

/*
 * Recognizes standard ASL signs from the sign dictionary (shared/dictionary.ts), with no
 * recordings. Ported from the asl-dictionary-chat branch (commit 220f562); the face box now comes
 * from the FaceLandmarker points the camera already tracks (faceBox.ts), passed in by
 * StreamingSignMatcher. A sign is two phases: hold a handshape at a location, then
 * move. It is an early-commit matcher: it fires the moment the movement has gone far enough,
 * not when the hand comes to rest, so a word shows up about a quarter of a second into the sign.
 *
 * The hold phase anchors where the hand rests; the anchor refreshes while the hand is still and
 * freezes once it moves. Then the move phase measures travel from the anchor while the
 * handshape holds.
 */

/** The hand must have stayed within this many hand lengths over STILL_MS to anchor. */
const STILL_DRIFT = 0.35
const STILL_MS = 120
/** The movement must happen within this long of the anchor. */
const MAX_TRAVEL_MS = 900
/** Two hands take longer to gather than one hand to sweep: the gap is compared against this much history. */
const TWO_HAND_WINDOW_MS = 1500
/** A frame where the handshape (or tracking) fails is forgiven for this long: landmark jitter flickers single frames. */
const GRACE_MS = 180
/** After a sign fires, the same sign cannot fire again for this long (another sign can: a phrase streams word by word). */
const COOLDOWN_MS = 900
/**
 * A start held still longer than this is a held hand (a control gesture, a pause), not the start
 * of a sign: lowering an open palm held beside the face is no HELLO. A real start rests a few
 * hundred ms (ASL Citizen signers: ~0.1-0.4 s).
 */
const MAX_HOLD_MS = 600
/** A stroke this straight (sideways over up-down) and this fast on average (frame widths/s) is a swipe (gestures/motion.ts). */
const SWIPE_STRAIGHTNESS = 2.2
const SWIPE_LIKE_SPEED = 1.0

interface Point {
  /** Which hand this is, so two hands in view are never mistaken for one hand moving. */
  hand: 'Left' | 'Right'
  t: number
  /** Anchors: when the hand came to rest there. */
  since?: number
  /** Palm center in aspect-corrected image units (fractions of the image height). */
  x: number
  y: number
  scale: number
}

function ruleHolds(rule: FingerRule | undefined, state: HandShape['state']['thumb']): boolean {
  if (!rule || rule === 'any') return true
  return rule === 'curled' ? state !== 'extended' : state === rule
}

export function handshapeMatches(def: HandshapeDef, s: HandShape, hand?: HandSample, aspect = 1): boolean {
  if (!FINGERS.every((f) => ruleHolds(def.fingers[f], s.state[f]))) return false
  if (!ruleHolds(def.thumb, s.state.thumb)) return false
  if (def.spreadMax !== undefined && s.spread > def.spreadMax) return false
  if (def.pinchMin === undefined && def.pinchMax === undefined) return true
  if (!hand) return false
  const pinch = fingertipPinch(hand, aspect) / s.palmSize
  return pinch >= (def.pinchMin ?? -Infinity) && pinch <= (def.pinchMax ?? Infinity)
}

const TIPS = [8, 12, 16, 20]

/** Mean distance from the thumb tip to the four fingertips (aspect-corrected, like palmSize). */
function fingertipPinch(hand: HandSample, aspect: number): number {
  const t = hand.landmarks[4]
  let sum = 0
  for (const i of TIPS) {
    const p = hand.landmarks[i]
    sum += Math.hypot((p.x - t.x) * aspect, p.y - t.y, (p.z - t.z) * aspect)
  }
  return sum / TIPS.length
}

/** Whether the palm center (normalized image coordinates) is inside a location, resolving face-relative ones. */
export function inLocation(dict: Dictionary, name: string, nx: number, ny: number, face: FaceBox | undefined): boolean {
  let loc: LocationDef | undefined = dict.locations[name]
  if (loc?.anchor === 'face' && !face) loc = loc.fallback ? dict.locations[loc.fallback] : undefined
  if (!loc) return false
  const { xMin, xMax, yMin, yMax } = loc.region
  if (loc.anchor === 'face') {
    if (!face) return false
    const dx = (nx - face.cx) / face.w
    const dy = (ny - face.cy) / face.h
    return dx >= xMin && dx <= xMax && dy >= yMin && dy <= yMax
  }
  return nx >= xMin && nx <= xMax && ny >= yMin && ny <= yMax
}

interface CompiledSign {
  gloss: string
  hands: 1 | 2
  hold: HandshapeDef
  /** One-handed signs only. */
  holdLocation: string
  /** The landmark that must be at the hold location, or null for the palm centre. */
  holdPoint: number | null
  move: HandshapeDef
  movement: MovementDef
}

function compile(dict: Dictionary): CompiledSign[] {
  const out: CompiledSign[] = []
  for (const s of dict.signs as SignDef[]) {
    const [hold, move] = s.phases
    const holdShape = dict.handshapes[hold?.handshape]
    const moveShape = dict.handshapes[move?.handshape]
    const movement = dict.movements[move?.movement ?? '']
    if (!holdShape || !moveShape || !movement) continue
    if (s.hands === 2) {
      if (movement.kind === 'together') out.push({ gloss: s.gloss, hands: 2, hold: holdShape, holdLocation: '', holdPoint: null, move: moveShape, movement })
    } else if (movement.kind === 'outward' && hold.location && dict.locations[hold.location]) {
      out.push({ gloss: s.gloss, hands: 1, hold: holdShape, holdLocation: hold.location, holdPoint: hold.point ?? null, move: moveShape, movement })
    }
  }
  return out
}

export class LexiconMatcher {
  private signs: CompiledSign[]
  private trail: Point[] = []
  private anchor: Point | null = null
  private readonly cooldownUntil = new Map<string, number>()
  private lastFitT = -Infinity
  /** Two-handed signs: the recent gap between the hands, in hand lengths, and whether both showed the start shape. */
  private gaps: { t: number; gap: number; start: boolean }[] = []
  /** Dev diagnostics: what the matchers saw on the last frame (one-handed, then two-handed). */
  get debug(): string {
    return [this.debugOne, this.debugTwo].filter(Boolean).join(' || ')
  }
  private debugOne = ''
  private debugTwo = ''

  constructor(private dict: Dictionary = { handshapes: {}, locations: {}, movements: {}, signs: [] }) {
    this.signs = compile(dict)
  }

  /** How many dictionary signs compiled (a sign naming something undefined is skipped). */
  get size(): number {
    return this.signs.length
  }

  /** True while a handshape is held at a sign's start and the movement has not happened yet. */
  get armed(): boolean {
    return this.anchor !== null
  }

  reset(): void {
    this.trail = []
    this.anchor = null
    this.gaps = []
  }

  /** The one-handed matcher lost its hand. Two-handed history is its own and is not touched. */
  private dropOneHanded(): void {
    this.trail = []
    this.anchor = null
  }

  /**
   * Feeds one frame. Returns the gloss of a sign that just completed, or null. `face` is the
   * viewer's face box (held across frames without one by the caller); without it face-relative
   * locations use their frame fallback.
   */
  update(frame: FrameSample, aspect: number, face?: FaceBox): string | null {
    const both = this.updateTwoHanded(frame, aspect)
    if (both) return both
    for (const sign of this.signs) {
      if (sign.hands !== 1 || sign.movement.kind !== 'outward') continue
      const analyzed = frame.hands.map((h) => ({ h, s: analyzeHand(h, aspect) }))
      // Once a hand is being followed, only that hand counts (the other one may match the handshape too).
      const following = this.anchor?.hand ?? this.trail[this.trail.length - 1]?.hand
      const fit = analyzed.find(
        ({ h, s }) =>
          (!following || h.handedness === following) && handshapeMatches(sign.move, s, h, aspect) && handshapeMatches(sign.hold, s, h, aspect)
      )
      if (frame.hands.length > 0) this.debugOne = this.describe(sign, analyzed[0].h, analyzed[0].s, aspect, face)
      if (!fit) {
        if (frame.t - this.lastFitT > GRACE_MS) this.dropOneHanded()
        continue
      }
      this.lastFitT = frame.t
      const m = measureHand(fit.h, aspect)
      if (!m) continue
      const here: Point = { hand: fit.h.handedness, t: frame.t, x: m.x, y: m.y, scale: m.scale }
      this.trail.push(here)
      while (this.trail.length > 1 && frame.t - this.trail[0].t > MAX_TRAVEL_MS + STILL_MS) this.trail.shift()

      if (frame.t < (this.cooldownUntil.get(sign.gloss) ?? -Infinity)) continue
      const a = this.anchor
      const still = this.isStill(here)
      if (still && a !== null && Math.hypot(here.x - a.x, here.y - a.y) / a.scale < STILL_DRIFT) {
        // Resting at the start: slow drift doesn't drag the anchor along, or a slow start would hide the travel.
        this.anchor = { ...a, t: here.t }
        continue
      }
      const at = sign.holdPoint === null ? { x: here.x / aspect, y: here.y } : fit.h.landmarks[sign.holdPoint]
      if (still && at && inLocation(this.dict, sign.holdLocation, at.x, at.y, face)) {
        this.anchor = { ...here, since: here.t }
        continue
      }
      // A slow glide away from the start (which a real start often is) keeps the anchor; the
      // travel is measured once the hand moves.
      if (!a || still) continue
      if (frame.t - a.t > MAX_TRAVEL_MS) {
        this.anchor = null
        continue
      }
      if (a.t - (a.since ?? a.t) > MAX_HOLD_MS) continue
      if (sign.movement.kind === 'outward' && this.traveled(sign.movement, a, here, aspect) === true) {
        this.anchor = null
        this.trail = []
        this.cooldownUntil.set(sign.gloss, frame.t + COOLDOWN_MS)
        return sign.gloss
      }
    }
    return null
  }

  private describe(sign: CompiledSign, hand: HandSample, s: HandShape, aspect: number, faceBox: FaceBox | undefined): string {
    const m = measureHand(hand, aspect)
    const a = this.anchor
    const d = a && m ? Math.hypot(m.x - a.x, m.y - a.y) / a.scale : 0
    const p = sign.holdPoint === null ? (m ? { x: m.x / aspect, y: m.y } : null) : hand.landmarks[sign.holdPoint]
    const at = p && sign.holdLocation ? inLocation(this.dict, sign.holdLocation, p.x, p.y, faceBox) : false
    const face = faceBox ? 'face' : 'no-face'
    return (
      `${sign.gloss}: fingers ${FINGERS.map((f) => s.state[f][0]).join('')} spread ${s.spread.toFixed(0)} ` +
      `y ${m ? m.y.toFixed(2) : '?'} ${face} at-${sign.holdLocation} ${at ? 'yes' : 'no'} ` +
      `anchor ${a ? 'yes' : 'no'} travel ${d.toFixed(2)}/${sign.movement.kind === 'outward' ? sign.movement.minHandLengths : 0}`
    )
  }

  /** Within STILL_DRIFT hand lengths of where it was STILL_MS ago. */
  private isStill(here: Point): boolean {
    const past = [...this.trail].reverse().find((p) => here.t - p.t >= STILL_MS)
    if (!past) return true
    return Math.hypot(here.x - past.x, here.y - past.y) / here.scale < STILL_DRIFT
  }

  /**
   * Two-handed signs where the hands come together (MEETING): both hands show the handshape, and
   * the gap between them, in hand lengths, has just closed by enough to a small enough gap.
   */
  private updateTwoHanded(frame: FrameSample, aspect: number): string | null {
    const sign = this.signs.find((s) => s.hands === 2)
    if (!sign || sign.movement.kind !== 'together') return null
    const [a, b] = frame.hands
    if (frame.hands.length !== 2 || !a || !b) {
      this.debugTwo = `${sign.gloss}: needs both hands in view (sees ${frame.hands.length})`
      const last = this.gaps[this.gaps.length - 1]
      if (!last || frame.t - last.t > GRACE_MS) this.gaps = []
      return null
    }
    const ma = measureHand(a, aspect)
    const mb = measureHand(b, aspect)
    if (!ma || !mb) return null
    const gap = Math.hypot(ma.x - mb.x, ma.y - mb.y) / ((ma.scale + mb.scale) / 2)
    const [sa, sb] = [analyzeHand(a, aspect), analyzeHand(b, aspect)]
    const start = handshapeMatches(sign.hold, sa, a, aspect) && handshapeMatches(sign.hold, sb, b, aspect)
    this.gaps.push({ t: frame.t, gap, start })
    while (this.gaps.length > 1 && frame.t - this.gaps[0].t > TWO_HAND_WINDOW_MS) this.gaps.shift()
    const shapeOk = handshapeMatches(sign.move, sa, a, aspect) && handshapeMatches(sign.move, sb, b, aspect)
    // The gap closes from where both hands showed the start shape (MEETING: open hands).
    const widest = Math.max(0, ...this.gaps.filter((g) => g.start).map((g) => g.gap))
    this.debugTwo = `${sign.gloss}: both hands ${shapeOk ? 'flat-O' : 'not flat-O'} gap ${gap.toFixed(2)} widest ${widest.toFixed(2)} need close by ${sign.movement.closeByHandLengths} to <= ${sign.movement.endGapHandLengths}`
    if (frame.t < (this.cooldownUntil.get(sign.gloss) ?? -Infinity) || !shapeOk) return null
    if (widest - gap >= sign.movement.closeByHandLengths && gap <= sign.movement.endGapHandLengths) {
      this.gaps = []
      this.cooldownUntil.set(sign.gloss, frame.t + COOLDOWN_MS)
      return sign.gloss
    }
    return null
  }

  private traveled(movement: Extract<MovementDef, { kind: 'outward' }>, from: Point, to: Point, aspect: number): boolean | 'swipe' {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dist = Math.hypot(dx, dy) / from.scale
    if (dist < movement.minHandLengths) return false
    // A straight sideways stroke as fast as a swipe is the swipe control, not a sign (real
    // HELLOs from ASL Citizen signers peak below 1.2 frame widths/s; a swipe needs 1.2).
    const widthsPerSecond = Math.abs(dx) / aspect / Math.max((to.t - from.t) / 1000, 1e-3)
    if (Math.abs(dx) > SWIPE_STRAIGHTNESS * Math.abs(dy) && widthsPerSecond >= SWIPE_LIKE_SPEED) return 'swipe'
    return Math.abs(dx) / Math.max(Math.hypot(dx, dy), 1e-9) >= movement.sidewaysShare
  }
}
