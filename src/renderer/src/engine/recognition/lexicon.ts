import type { Dictionary, FingerRule, HandshapeDef, LocationDef, MovementDef, SignDef } from '@shared/dictionary'
import { analyzeHand, FINGERS, type HandShape } from '../gestures/handShape'
import type { FaceBox, FrameSample, HandSample } from '../types'
import { measureHand } from './features'

/*
 * Recognizes standard ASL signs from the sign dictionary (shared/dictionary.ts, stored in
 * Supabase), with no recordings. A sign is two phases: hold a handshape at a location, then
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
/** After a sign fires, the same hand cannot fire again for this long. */
const COOLDOWN_MS = 900

interface Point {
  /** Which hand this is, so two hands in view are never mistaken for one hand moving. */
  hand: 'Left' | 'Right'
  t: number
  /** Palm center in aspect-corrected image units (fractions of the image height). */
  x: number
  y: number
  scale: number
}

function ruleHolds(rule: FingerRule | undefined, state: HandShape['state']['thumb']): boolean {
  if (!rule || rule === 'any') return true
  return rule === 'curled' ? state !== 'extended' : state === rule
}

export function handshapeMatches(def: HandshapeDef, s: HandShape): boolean {
  if (!FINGERS.every((f) => ruleHolds(def.fingers[f], s.state[f]))) return false
  if (!ruleHolds(def.thumb, s.state.thumb)) return false
  return def.spreadMax === undefined || s.spread <= def.spreadMax
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
      if (movement.kind === 'together') out.push({ gloss: s.gloss, hands: 2, hold: holdShape, holdLocation: '', move: moveShape, movement })
    } else if (movement.kind === 'outward' && hold.location && dict.locations[hold.location]) {
      out.push({ gloss: s.gloss, hands: 1, hold: holdShape, holdLocation: hold.location, move: moveShape, movement })
    }
  }
  return out
}

export class LexiconMatcher {
  private signs: CompiledSign[]
  private trail: Point[] = []
  private anchor: Point | null = null
  private cooldownUntil = -Infinity
  private lastFitT = -Infinity
  /** Two-handed signs: the recent gap between the hands, in hand lengths. */
  private gaps: { t: number; gap: number }[] = []
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

  /** Feeds one frame. Returns the gloss of a sign that just completed, or null. */
  update(frame: FrameSample, aspect: number): string | null {
    const both = this.updateTwoHanded(frame, aspect)
    if (both) return both
    for (const sign of this.signs) {
      if (sign.hands !== 1 || sign.movement.kind !== 'outward') continue
      const analyzed = frame.hands.map((h) => ({ h, s: analyzeHand(h, aspect) }))
      // Once a hand is being followed, only that hand counts (the other one may match the handshape too).
      const following = this.anchor?.hand ?? this.trail[this.trail.length - 1]?.hand
      const fit = analyzed.find(
        ({ h, s }) => (!following || h.handedness === following) && handshapeMatches(sign.move, s) && handshapeMatches(sign.hold, s)
      )
      if (frame.hands.length > 0) this.debugOne = this.describe(sign, frame, analyzed[0].h, analyzed[0].s, aspect)
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

      if (frame.t < this.cooldownUntil) continue
      if (this.isStill(here)) {
        // Anchor where the hand rests; slow drift doesn't drag it along, or a slow start would hide the travel.
        const a = this.anchor
        const nearAnchor = a !== null && Math.hypot(here.x - a.x, here.y - a.y) / a.scale < STILL_DRIFT
        if (nearAnchor) this.anchor = { ...a, t: here.t }
        else if (inLocation(this.dict, sign.holdLocation, here.x / aspect, here.y, frame.face)) this.anchor = here
        else this.anchor = null
        continue
      }
      const a = this.anchor
      if (!a) continue
      if (frame.t - a.t > MAX_TRAVEL_MS) {
        this.anchor = null
        continue
      }
      if (sign.movement.kind === 'outward' && this.traveled(sign.movement, a, here)) {
        this.anchor = null
        this.trail = []
        this.cooldownUntil = frame.t + COOLDOWN_MS
        return sign.gloss
      }
    }
    return null
  }

  private describe(sign: CompiledSign, frame: FrameSample, hand: HandSample, s: HandShape, aspect: number): string {
    const m = measureHand(hand, aspect)
    const a = this.anchor
    const d = a && m ? Math.hypot(m.x - a.x, m.y - a.y) / a.scale : 0
    const at = m && sign.holdLocation ? inLocation(this.dict, sign.holdLocation, m.x / aspect, m.y, frame.face) : false
    const face = frame.face ? 'face' : 'no-face'
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
    this.gaps.push({ t: frame.t, gap })
    while (this.gaps.length > 1 && frame.t - this.gaps[0].t > TWO_HAND_WINDOW_MS) this.gaps.shift()
    const shapeOk = handshapeMatches(sign.move, analyzeHand(a, aspect)) && handshapeMatches(sign.move, analyzeHand(b, aspect))
    const widest = Math.max(...this.gaps.map((g) => g.gap))
    this.debugTwo = `${sign.gloss}: both hands ${shapeOk ? 'flat-O' : 'not flat-O'} gap ${gap.toFixed(2)} widest ${widest.toFixed(2)} need close by ${sign.movement.closeByHandLengths} to <= ${sign.movement.endGapHandLengths}`
    if (frame.t < this.cooldownUntil || !shapeOk) return null
    if (widest - gap >= sign.movement.closeByHandLengths && gap <= sign.movement.endGapHandLengths) {
      this.gaps = []
      this.cooldownUntil = frame.t + COOLDOWN_MS
      return sign.gloss
    }
    return null
  }

  private traveled(movement: Extract<MovementDef, { kind: 'outward' }>, from: Point, to: Point): boolean {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dist = Math.hypot(dx, dy) / from.scale
    if (dist < movement.minHandLengths) return false
    return Math.abs(dx) / Math.max(Math.hypot(dx, dy), 1e-9) >= movement.sidewaysShare
  }
}
