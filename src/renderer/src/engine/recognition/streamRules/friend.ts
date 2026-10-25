import type { FrameSample } from '../../types'
import { framesOf, indexGap, indexOnly, pairUp, type Hand } from './twoHandSigns'
import type { StreamContext, StreamRule } from './types'

/*
 * FRIEND: both hands in X (index hooked, the other fingers closed). The dominant index hooks over
 * the other, the hands come apart a little as they flip over, and hook again the other way round.
 *
 * What the camera sees of that, in 2D: the two index fingers touch, separate, and touch again,
 * with both hands moving around each other in between (one rises as the other drops). The flip
 * itself is mostly a turn in depth that the image barely shows, so the rule keys on the two
 * hooks with the release between them, both hands moving, the fingers pointing at each other and
 * both hands holding an index-only shape. It fires the moment the second hook closes.
 *
 * Nothing static can fire it: it needs two contacts with a release between (a held shape has
 * none), both hands in view and close (a one-hand swipe has no second hand), both hands moving
 * (TIME taps a still base), and both hands with only the index out (a fist has none, an open palm
 * or MEETING's flat O all four). Which hand is which comes from position, never from the
 * handedness label, so left-handed signers work too. Registered before TIME (index.ts).
 */

/** Thresholds, in hand lengths (wrist → middle knuckle) and ms. Tuned on ASL Citizen (friend.eval.test.ts). */
export const FRIEND_TUNING = {
  /** History looked at: both hooks and the flip between them. */
  ms: 1500,
  /** The index fingers touch: the closest points of the two hooked fingers (PIP, DIP, tip) within this. */
  contact: 0.3,
  /** Between the hooks they come apart: at least this far ... */
  release: 0.5,
  /** ... and at least this much further apart than at the first hook. */
  rise: 0.4,
  /** The palms are this close at both hooks (hooked fingers keep the hands near). */
  near: 3,
  /** Share of the frames from the end of the first hook on where each hand holds an index-only shape (twoHandSigns indexOnly: an X, or a 1). */
  shapeShare: 0.5,
  /** The second hook comes at most this long after the release's widest point. */
  closeMs: 700,
  /** Both hands turn over: from the end of the first hook on, each palm moves at least this far (TIME's base holds still). */
  bothMove: 0.12,
  /**
   * The hooked fingers point at each other: over the hook frames, the median of the smaller of the
   * two cosines between an index (knuckle → tip) and the way to the other hand's palm is at least
   * this. Two 1s held up side by side and tapped together point up, past each other (about 0).
   */
  toward: 0.1
}

/** Both hands in one frame. */
interface Pair {
  t: number
  a: Hand
  b: Hand
}

/** Cosine between the hand's index (knuckle → tip) and the way to the other hand's palm: 1 pointing right at it. */
function pointsAt(h: Hand, other: Hand): number {
  const dx = h.pts[8].x - h.pts[5].x
  const dy = h.pts[8].y - h.pts[5].y
  const ox = other.x - h.x
  const oy = other.y - h.y
  return (dx * ox + dy * oy) / Math.max(Math.hypot(dx, dy) * Math.hypot(ox, oy), 1e-12)
}

function median(values: readonly number[]): number {
  const s = [...values].sort((p, q) => p - q)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Why the window is not FRIEND: the first requirement it misses, or '' when FRIEND fires (the
 * eval prints these for the clips it misses).
 */
export function friendMiss(history: readonly FrameSample[], { aspect }: StreamContext): string {
  const P = FRIEND_TUNING
  const frames = framesOf(history, aspect, P.ms)
  if (frames[frames.length - 1].hands.length !== 2) return 'one hand now'
  const pair = pairUp(frames)
  const both: Pair[] = []
  pair.t.forEach((t, i) => {
    const a = pair.a[i]
    const b = pair.b[i]
    if (a && b) both.push({ t, a, b })
  })
  if (both.length < 6) return 'few two-hand frames'
  const L = (median(both.map((p) => p.a.len)) + median(both.map((p) => p.b.len))) / 2
  const gap = both.map((p) => indexGap(p.a, p.b) / L)
  const palms = both.map((p) => Math.hypot(p.a.x - p.b.x, p.a.y - p.b.y) / L)
  const n = both.length - 1
  // The second hook is closed now: frames k..n.
  if (gap[n] > P.contact) return 'no hook now'
  if (palms[n] > P.near) return 'hands apart now'
  let k = n
  while (k > 0 && gap[k - 1] <= P.contact) k--
  // Before it, back to the last frame of the first hook (i): the release, widest at j.
  let j = -1
  let i = -1
  for (let m = k - 1; m >= 0; m--) {
    if (gap[m] <= P.contact) {
      i = m
      break
    }
    if (j < 0 || gap[m] > gap[j]) j = m
  }
  if (j < 0) return 'no release'
  if (i < 0) return 'no first hook'
  if (palms[i] > P.near) return 'hands apart at the first hook'
  if (gap[j] < P.release || gap[j] - gap[i] < P.rise) return `release too small ${gap[j].toFixed(2)}`
  if (both[k].t - both[j].t > P.closeMs) return 'second hook too late'
  // The first hook: frames i0..i.
  let i0 = i
  while (i0 > 0 && gap[i0 - 1] <= P.contact) i0--
  const hooks = [...both.slice(i0, i + 1), ...both.slice(k)]
  const toward = median(hooks.map((p) => Math.min(pointsAt(p.a, p.b), pointsAt(p.b, p.a))))
  if (toward < P.toward) return `fingers point past each other ${toward.toFixed(2)}`
  // From the first hook letting go: both hands turn over, each holding an X (or a 1). (A tight
  // hook often reads as a folded index, so the first hook itself is not counted.)
  const span = both.slice(i)
  const moved = (pick: (p: Pair) => Hand): number => Math.max(...span.map((p) => Math.hypot(pick(p).x - pick(span[0]).x, pick(p).y - pick(span[0]).y))) / L
  const still = Math.min(moved((p) => p.a), moved((p) => p.b))
  if (still < P.bothMove) return `one hand still ${still.toFixed(2)}`
  const share = (pick: (p: Pair) => Hand): number => span.filter((p) => indexOnly(pick(p))).length / span.length
  const sa = share((p) => p.a)
  const sb = share((p) => p.b)
  if (sa < P.shapeShare || sb < P.shapeShare) return `shape ${sa.toFixed(2)} ${sb.toFixed(2)}`
  return ''
}

export const friendFires = (history: readonly FrameSample[], ctx: StreamContext): boolean => friendMiss(history, ctx) === ''

export const friend: StreamRule = { word: 'friend', hands: 2, fires: friendFires }
