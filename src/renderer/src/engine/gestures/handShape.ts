import type { HandSample } from '../types'
import { angleDeg, cross, distance, length, ramp, sub, vec, type Vec3 } from './vec'

/**
 * Per-hand static shape analysis on MediaPipe's 21 landmarks.
 *
 * All geometry runs in an isotropic space: landmark x (and z, which MediaPipe
 * scales like x) is multiplied by the source aspect ratio so a 16:9 frame does
 * not squash sideways fingers. Finger tests are rotation invariant (3D joint
 * angles and distances); only "pointing up" and the thumbs-up test use image
 * directions, on purpose.
 */

export type Digit = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'
export type Finger = Exclude<Digit, 'thumb'>
export type DigitState = 'extended' | 'partial' | 'folded'

export const DIGITS: readonly Digit[] = ['thumb', 'index', 'middle', 'ring', 'pinky']
export const FINGERS: readonly Finger[] = ['index', 'middle', 'ring', 'pinky']

/** MediaPipe landmark indices, base to tip (thumb: CMC, MCP, IP, tip; fingers: MCP, PIP, DIP, tip). */
export const CHAIN: Record<Digit, readonly [number, number, number, number]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20]
}
export const WRIST = 0
export const LANDMARK_COUNT = 21

/** Extension score at or above which a digit counts as extended / at or below which it counts as folded. */
const EXTENDED_AT = 0.7
const FOLDED_AT = 0.3
/** Finger PIP + DIP bend (degrees): straight below the first value, fully curled above the second. */
const FINGER_BEND: [number, number] = [35, 100]
/** Fingertip distance from the wrist over PIP distance from the wrist: < 1 means the tip is tucked in. */
const FINGER_REACH: [number, number] = [0.95, 1.25]
/**
 * Thumb straightness: CMC → tip chord over the CMC → MCP → IP → tip path length.
 * Used instead of joint angles because the thumb's short segments make angle sums
 * noisy (jitter always adds bend); the ratio is only second-order in noise.
 */
const THUMB_STRAIGHT: [number, number] = [0.85, 0.95]
/** Thumb tip distance from the index MCP, in palm sizes: adducted below, abducted above. */
const THUMB_REACH: [number, number] = [0.35, 0.6]
/** Straightness above which the thumb counts as straight for "thumb pointing up". */
const THUMB_STRAIGHT_AT = 0.88
/** cos(45°): thumb direction within 45° of image-up. Used to keep ASL A out of "fist". */
const THUMB_POINTS_UP = 0.707
/** cos(40°): stricter direction for an actual thumbs-up. */
const THUMBS_UP_DIRECTION = 0.766
/** Thumbs-up tip must rise this far (palm sizes) above every other finger landmark. */
const THUMBS_UP_RISE = 0.25
/** cos(60°): hand (wrist → middle MCP) roughly upright. */
const UPRIGHT = 0.5
/** |palmFacing| needed for an open palm (palm plane within ~60° of facing the camera). */
const FACING = 0.5
/** Index / middle angle (degrees) that separates a V (peace) from a closed U. */
const PEACE_SPREAD_DEG = 14

export interface HandShape {
  /** Wrist → middle-MCP length (3D, isotropic units: fractions of frame height). */
  palmSize: number
  /** 0 = curled, 1 = straight, per digit. */
  extension: Record<Digit, number>
  state: Record<Digit, DigitState>
  /**
   * +1 palm toward the camera, -1 back of the hand toward it, 0 edge-on. The sign
   * relies on MediaPipe's handedness label (subject's own hand for un-mirrored frames).
   */
  palmFacing: number
  /** Unit image-space direction wrist → middle MCP (y down, so upright ≈ {0, -1}). */
  pointing: { x: number; y: number }
  /** Thumb chord / path ratio: ~1 straight, ~0.75 tucked across the palm or fingers. */
  thumbStraightness: number
  /** Cosine between the thumb (MCP → tip) and image-up. */
  thumbUp: number
  /** How far the thumb tip sits above the highest other-finger landmark, in palm sizes. */
  thumbRise: number
  /** Angle between index and middle fingers in degrees. */
  spread: number
}

function toIsotropic(hand: HandSample, aspect: number): Vec3[] {
  return hand.landmarks.map((p) => vec(p.x * aspect, p.y, p.z * aspect))
}

function fingerExtension(p: Vec3[], [mcp, pip, dip, tip]: readonly number[]): number {
  // PIP + DIP flexion measured as one angle between the proximal and distal phalanges:
  // equal to the sum for a planar finger, with half the jitter bias of two angles.
  const bend = angleDeg(sub(p[pip], p[mcp]), sub(p[tip], p[dip]))
  const reach = distance(p[tip], p[WRIST]) / Math.max(distance(p[pip], p[WRIST]), 1e-6)
  return (1 - ramp(bend, ...FINGER_BEND) + ramp(reach, ...FINGER_REACH)) / 2
}

function thumbStraightness(p: Vec3[]): number {
  const [cmc, mcp, ip, tip] = CHAIN.thumb
  const path = distance(p[cmc], p[mcp]) + distance(p[mcp], p[ip]) + distance(p[ip], p[tip])
  return distance(p[cmc], p[tip]) / Math.max(path, 1e-9)
}

function stateOf(extension: number): DigitState {
  if (extension >= EXTENDED_AT) return 'extended'
  if (extension <= FOLDED_AT) return 'folded'
  return 'partial'
}

/** Analyze one hand. `aspect` is source width / height. */
export function analyzeHand(hand: HandSample, aspect = 1): HandShape {
  const p = toIsotropic(hand, aspect)
  const palmSize = Math.max(distance(p[WRIST], p[CHAIN.middle[0]]), 1e-6)

  const straightness = thumbStraightness(p)
  const thumbReach = distance(p[CHAIN.thumb[3]], p[CHAIN.index[0]]) / palmSize
  // The thumb must be both straight and abducted; either alone is a tucked or side-lying thumb.
  const thumb = Math.min(ramp(straightness, ...THUMB_STRAIGHT), ramp(thumbReach, ...THUMB_REACH))

  const extension = { thumb } as Record<Digit, number>
  for (const f of FINGERS) extension[f] = fingerExtension(p, CHAIN[f])
  const state = {} as Record<Digit, DigitState>
  for (const d of DIGITS) state[d] = stateOf(extension[d])

  const normal = cross(sub(p[CHAIN.index[0]], p[WRIST]), sub(p[CHAIN.pinky[0]], p[WRIST]))
  const facingSign = hand.handedness === 'Right' ? -1 : 1
  const palmFacing = (facingSign * normal.z) / Math.max(length(normal), 1e-9)

  const axis = sub(p[CHAIN.middle[0]], p[WRIST])
  const axisLen = Math.max(Math.hypot(axis.x, axis.y), 1e-9)

  const thumbDir = sub(p[CHAIN.thumb[3]], p[CHAIN.thumb[1]])
  const thumbUp = -thumbDir.y / Math.max(Math.hypot(thumbDir.x, thumbDir.y), 1e-9)
  let highest = Infinity
  for (const f of FINGERS) for (const i of CHAIN[f]) highest = Math.min(highest, p[i].y)

  return {
    palmSize,
    extension,
    state,
    palmFacing,
    pointing: { x: axis.x / axisLen, y: axis.y / axisLen },
    thumbStraightness: straightness,
    thumbUp,
    thumbRise: (highest - p[CHAIN.thumb[3]].y) / palmSize,
    spread: angleDeg(sub(p[CHAIN.index[3]], p[CHAIN.index[0]]), sub(p[CHAIN.middle[3]], p[CHAIN.middle[0]]))
  }
}

const is = (s: HandShape, d: Digit, state: DigitState): boolean => s.state[d] === state
const fingersFolded = (s: HandShape): boolean => FINGERS.every((f) => is(s, f, 'folded'))
const upright = (s: HandShape): boolean => -s.pointing.y >= UPRIGHT

/**
 * All five digits extended, hand upright, palm plane facing the camera. Uses
 * |palmFacing| so a wrong handedness label (MediaPipe has swapped them between
 * releases) cannot disable the gesture.
 */
export function isOpenPalm(s: HandShape): boolean {
  return DIGITS.every((d) => is(s, d, 'extended')) && Math.abs(s.palmFacing) >= FACING && upright(s)
}

/**
 * Thumb pointing up (ASL A or thumbs-up): aimed within 45° of up and either straight
 * or with its tip level with or above the knuckles.
 */
function thumbPointsUp(s: HandShape): boolean {
  return s.thumbUp >= THUMB_POINTS_UP && (s.thumbStraightness >= THUMB_STRAIGHT_AT || s.thumbRise >= 0)
}

/** Four fingers curled and the thumb not pointing up (so ASL A and thumbs-up are not fists). */
export function isFist(s: HandShape): boolean {
  return fingersFolded(s) && !thumbPointsUp(s)
}

/** Four fingers curled, thumb extended, pointing up and clearly above every knuckle. */
export function isThumbsUp(s: HandShape): boolean {
  return (
    fingersFolded(s) &&
    is(s, 'thumb', 'extended') &&
    s.thumbUp >= THUMBS_UP_DIRECTION &&
    s.thumbRise >= THUMBS_UP_RISE
  )
}

/**
 * Raised finger count: 1 index; 2 index+middle (V or U); 3 index+middle+ring
 * or ASL 3 (thumb+index+middle); 4 four fingers with the thumb folded; 5 open palm.
 * Unlisted combinations (e.g. L, Y, an open hand with a half-tucked thumb) are null.
 */
export function fingerCount(s: HandShape): number | null {
  if (isOpenPalm(s)) return 5
  if (!upright(s)) return null
  const thumb = s.state.thumb
  const [index, middle, ring, pinky] = FINGERS.map((f) => s.state[f])
  if (index === 'extended' && middle === 'extended' && ring === 'extended' && pinky === 'extended') {
    return thumb === 'folded' ? 4 : null
  }
  if (pinky !== 'folded') return null
  if (index === 'extended' && middle === 'extended' && ring === 'extended') return thumb === 'extended' ? null : 3
  if (ring !== 'folded') return null
  // A half-out thumb here is ambiguous between 2 and ASL 3, so neither.
  if (index === 'extended' && middle === 'extended') return thumb === 'extended' ? 3 : thumb === 'folded' ? 2 : null
  if (index === 'extended' && middle === 'folded') return thumb === 'extended' ? null : 1
  return null
}

/** V / peace: a count of 2 with the index and middle fingers spread apart. */
export function isPeace(s: HandShape): boolean {
  return fingerCount(s) === 2 && s.spread >= PEACE_SPREAD_DEG
}

/** At least three of the four fingers mostly straight: the hand shape required for swipes. */
export function isFlatHand(s: HandShape): boolean {
  return FINGERS.filter((f) => s.extension[f] >= 0.5).length >= 3
}
