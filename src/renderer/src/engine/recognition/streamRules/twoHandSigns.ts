import { analyzeHand } from '../../gestures/handShape'
import type { FrameSample, HandSample } from '../../types'
import type { StreamContext, StreamRule } from './types'

/*
 * Streaming rules for ASL signs made with both hands or on a non-dominant base hand:
 * OPEN, MUSIC, PLAY, STOP, TIME, EMAIL, WHAT, PLEASE.
 *
 * Every rule needs a movement, never a held shape alone, and every two-handed rule needs the
 * second hand in its role, so the control gestures (held shapes, one-hand swipes) can't fire them.
 *
 * Hands are told apart by position and continuity, not by MediaPipe's handedness label, and which
 * hand is dominant comes from what each hand does (the base hand holds still, the other moves), so
 * left-handed signers work too. All geometry is 2D in isotropic image units (x × aspect, y), in
 * hand lengths where it matters, so it does not depend on distance from the camera, and it does not
 * use landmark z (palm orientation comes from the 2D knuckle width instead).
 */

/**
 * Every rule's thresholds, in one place. Distances are in hand lengths (wrist → middle knuckle),
 * times in ms, shares are fractions of the window's frames. Tuned on ASL Citizen clips
 * (twoHandSigns.eval.test.ts).
 */
export const TUNING = {
  what: {
    /** History looked at. */
    ms: 1200,
    /** Share of frames each hand must be open (all four fingers straight). */
    openShare: 0.4,
    /** The hands stay at least this far apart sideways, and within `height` of each other vertically. */
    gap: 2.5,
    height: 2.5,
    /** Median knuckle-width ratio: palms up are foreshortened, so they look wide (an upright palm is ~0.6). */
    palmUp: 0.7,
    /** Sideways strokes of at least `amp`: each hand at least `strokes`, one of them at least `strokesMax`. */
    amp: 0.2,
    strokes: 2,
    strokesMax: 3,
    /** The window's first `onsetMs` must show the shake starting (a hand out of view, or both still). */
    onsetMs: 250
  },
  time: {
    ms: 1000,
    /** Share of frames the tapping hand points with the index. */
    pointShare: 0.4,
    /** The base hand is at least this far below the pointing hand, and moves less than `baseStill` up / down. */
    below: 0,
    baseStill: 3,
    /** Median base wrist → knuckle image direction y above this (-1 = fingers straight up). */
    baseUpright: -0.3,
    /** At most this share of the base hand's frames may be pointing (two pointing hands are GO, not TIME). */
    basePointing: 1,
    /** The fingertip ends within this distance of the base hand. */
    near: 1.2,
    /** Fingertip strokes up / down of at least `tap`: 2 = one tap (down and back up). */
    tap: 0.25,
    strokes: 1
  },
  open: {
    ms: 900,
    /** The horizontal gap starts at most `startGap` and grows by at least `spread`; each hand moves out `each`. */
    startGap: 2.2,
    spread: 2,
    each: 0.6,
    /** Vertical travel of either hand at most this share of the spread (hands dropping to rest are not OPEN). */
    drop: 0.6,
    flatShare: 0.8,
    /** Fingers not pointing down: wrist → knuckle image y below this. */
    notDown: -0.3,
    /** Share of the first 3 frames of the opening with both hands flat. */
    startFlat: 0,
    /** Median knuckle-width ratio of the last 3 frames at most this (palms up looks wide). */
    endWidth: 0.85,
    /** The opening takes at least this long, and no hand moves faster than `maxSpeed` hand lengths / s between frames. */
    minMs: 200,
    maxSpeed: 20
  },
  music: {
    ms: 1500,
    /** Frames the base hand must be seen in the window. */
    baseFrames: 1,
    /** The base is at least `below` lower than the swinging hand and moves less than `baseStill`. */
    below: 0.8,
    baseStill: 1.5,
    flatShare: 0.6,
    /** The swinging hand's fingers point sideways (|wrist → knuckle x| ≥ `sideways`) in `sidewaysShare` of frames. */
    sideways: 0.5,
    sidewaysShare: 0.6,
    /** Sideways strokes of at least `amp`. */
    amp: 0.4,
    strokes: 2
  },
  play: {
    ms: 1200,
    /** Share of frames each hand is a Y; the hands end at least `gap` apart sideways. */
    yShare: 0.5,
    gap: 1.2,
    /** Up / down strokes count only when the hand's vertical range in the window is at most this (NOW is a big rise and drop). */
    yRange: 1,
    /** Back-and-forth strokes per hand in thumb → pinky angle (degrees) or position (hand lengths). */
    twistDeg: 15,
    shake: 0.25,
    strokes: 2,
    strokesMax: 3
  },
  please: {
    ms: 1400,
    flatShare: 0.7,
    /** Fingers across the body: |wrist → knuckle x| ≥ `sideways` in `sidewaysShare` of frames. */
    sideways: 0.5,
    sidewaysShare: 0.8,
    /** With a face: the hand's median height between face centre + chestTop and + chestBottom face heights, within chestSide face widths sideways. */
    chestTop: 1,
    chestBottom: 3,
    chestSide: 1.5,
    /** The other hand, when seen, moves less than this. */
    otherStill: 0.6,
    /** The circle's extent (hand lengths): at least minX wide and minY tall, at most maxRange either way. */
    minX: 0.15,
    minY: 0.25,
    maxRange: 2,
    /** Degrees the palm must wind around the middle of its path, in PLEASE's direction (see winding). */
    turn: 400
  },
  stop: {
    ms: 800,
    /** The edge-on hand drops at least this far, mostly straight down (sideways at most `slant` × the drop). */
    drop: 1.0,
    slant: 1.5,
    /** Share of the fall the hand is flat, and edge-on (knuckle-width ratio ≤ `edgeWidth`). */
    flatShare: 0.6,
    edgeWidth: 0.45,
    edgeShare: 0.25,
    /** The lowest point of the chopping hand reaches within `reach` of the base hand's top, and within `side` sideways. */
    reach: 0.3,
    side: 2.5,
    /** The base hand was at least this far below where the chop started. */
    baseBelow: 1.0,
    /** Median base wrist → knuckle image direction y above this (-1 = fingers straight up). */
    baseUpright: -2
  },
  email: {
    ms: 1000,
    /** Share of frames the moving hand points with the index; the base may point in at most `basePointing`. */
    pointShare: 0.6,
    basePointing: 0.5,
    /** Median base wrist → knuckle image direction y at most this (the base hand stands up). */
    baseUpright: -0.5,
    /** The base moves less than this. */
    baseStill: 0.8,
    /** The fingertip ends within `near` of the base hand, having travelled `slide` relative to it; the hand's net move toward the base is at least `toward`. */
    near: 1.2,
    slide: 1.1,
    toward: -10,
    /** The fingertip's travel across the base (x) is at least this × its travel up / down. */
    across: 0
  }
}

// ----------------------------------------------------------------------------------- hands

/** One hand in one frame, in isotropic image units (x × aspect, y; fractions of the frame height). */
export interface Hand {
  t: number
  /** Palm centre: mean of the wrist and the four knuckles. */
  x: number
  y: number
  /** Wrist → middle-knuckle length (uses z when the tracker gives it). */
  len: number
  /**
   * Knuckle width (index → pinky MCP) over the wrist → middle-knuckle length, both as seen in the
   * image: ~0.7 for a palm (or back of the hand) square to the camera, small when the hand is
   * edge-on, large when the palm is foreshortened (palm up or down, fingers toward the camera).
   */
  width: number
  /** Unit image direction wrist → middle knuckle (y down: upright fingers have dy ≈ -1). */
  dx: number
  dy: number
  /** The 21 landmarks in isotropic units. */
  pts: { x: number; y: number }[]
  /** Extension 0 (curled) .. 1 (straight): thumb, index, middle, ring, pinky. */
  ext: readonly number[]
  /**
   * The tracker's handedness label: +1 'Right' (the app's HandLandmarker labels the signer's own
   * right hand 'Right'), -1 'Left'. It flickers, and both hands can get the same label, so it is
   * only used as a vote over a window.
   */
  right: number
}

export interface Frame {
  t: number
  hands: Hand[]
}

const WRIST = 0
const PALM = [0, 5, 9, 13, 17]
/** A hand shorter than this (frame heights) is a tracking glitch, not a hand. */
const MIN_LEN = 0.04
/** Two hands whose palms are this close (hand lengths) with similar sizes are one hand reported twice. */
const DUPLICATE_GAP = 0.3

const cache = new WeakMap<HandSample, { aspect: number; hand: Hand | null }>()

function measure(sample: HandSample, t: number, aspect: number): Hand | null {
  const hit = cache.get(sample)
  if (hit && hit.aspect === aspect) return hit.hand
  const hand = measureUncached(sample, t, aspect)
  cache.set(sample, { aspect, hand })
  return hand
}

function measureUncached(sample: HandSample, t: number, aspect: number): Hand | null {
  const lm = sample.landmarks
  if (lm.length < 21 || !lm.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null
  const pts = lm.map((p) => ({ x: p.x * aspect, y: p.y }))
  const w = lm[WRIST]
  const m = lm[9]
  const dz = Number.isFinite(m.z) && Number.isFinite(w.z) ? (m.z - w.z) * aspect : 0
  const ax = pts[9].x - pts[WRIST].x
  const ay = pts[9].y - pts[WRIST].y
  const len2 = Math.hypot(ax, ay)
  const len = Math.hypot(ax, ay, dz)
  if (!(len >= MIN_LEN)) return null
  const knuckles = Math.hypot(pts[5].x - pts[17].x, pts[5].y - pts[17].y)
  const shape = analyzeHand(sample, aspect)
  const ext = [shape.extension.thumb, shape.extension.index, shape.extension.middle, shape.extension.ring, shape.extension.pinky]
  return {
    t,
    x: PALM.reduce((s, i) => s + pts[i].x, 0) / PALM.length,
    y: PALM.reduce((s, i) => s + pts[i].y, 0) / PALM.length,
    len,
    width: knuckles / Math.max(len2, 1e-6),
    dx: ax / Math.max(len2, 1e-9),
    dy: ay / Math.max(len2, 1e-9),
    pts,
    ext,
    right: sample.handedness === 'Right' ? 1 : -1
  }
}

/** The usable hands of a frame: glitches dropped, a hand reported twice kept once, at most two. */
export function handsOf(frame: FrameSample, aspect: number): Hand[] {
  const hands: Hand[] = []
  for (const sample of frame.hands) {
    const h = measure(sample, frame.t, aspect)
    if (!h) continue
    const twin = hands.find(
      (o) => Math.hypot(o.x - h.x, o.y - h.y) < DUPLICATE_GAP * Math.min(o.len, h.len) && Math.abs(o.len - h.len) < 0.25 * Math.max(o.len, h.len)
    )
    if (!twin) hands.push(h)
  }
  if (hands.length > 2) hands.sort((a, b) => b.len - a.len).splice(2)
  // A hand under 40% of the other's size beside it is a ghost (a partial hand at the frame edge).
  if (hands.length === 2) {
    const [a, b] = hands
    if (a.len < 0.4 * b.len) return [b]
    if (b.len < 0.4 * a.len) return [a]
  }
  return hands
}

export function framesOf(history: readonly FrameSample[], aspect: number, ms: number): Frame[] {
  const now = history[history.length - 1].t
  const out: Frame[] = []
  for (const f of history) if (now - f.t <= ms) out.push({ t: f.t, hands: handsOf(f, aspect) })
  return out
}

// ---------------------------------------------------------------------------------- tracks

/** Two hands followed through a window by continuity: per frame, each slot's hand or null. */
export interface Pair {
  t: number[]
  a: (Hand | null)[]
  b: (Hand | null)[]
}

/** A hand last seen longer ago than this no longer anchors its slot. */
const TRACK_MEMORY_MS = 500

const dist = (p: Hand, q: Hand): number => Math.hypot(p.x - q.x, p.y - q.y)

/**
 * Slots the hands of each frame into two tracks. With both hands in view the assignment that moves
 * them least from where each slot last was wins (labels are ignored: MediaPipe's flicker); with no
 * recent slot positions the left one in the image goes to slot a. A lone hand joins the nearer slot.
 */
export function pairUp(frames: readonly Frame[]): Pair {
  const pair: Pair = { t: [], a: [], b: [] }
  let lastA: Hand | null = null
  let lastB: Hand | null = null
  for (const f of frames) {
    if (lastA && f.t - lastA.t > TRACK_MEMORY_MS) lastA = null
    if (lastB && f.t - lastB.t > TRACK_MEMORY_MS) lastB = null
    let a: Hand | null = null
    let b: Hand | null = null
    if (f.hands.length === 2) {
      const [h0, h1] = f.hands
      if (lastA && lastB) {
        const keep: number = dist(h0, lastA) + dist(h1, lastB)
        const swap: number = dist(h1, lastA) + dist(h0, lastB)
        ;[a, b] = keep <= swap ? [h0, h1] : [h1, h0]
      } else if (lastA || lastB) {
        const ref = (lastA ?? lastB) as Hand
        const near = dist(h0, ref) <= dist(h1, ref) ? h0 : h1
        const far = near === h0 ? h1 : h0
        ;[a, b] = lastA ? [near, far] : [far, near]
      } else {
        ;[a, b] = h0.x <= h1.x ? [h0, h1] : [h1, h0]
      }
    } else if (f.hands.length === 1) {
      const h = f.hands[0]
      if (lastA && lastB) {
        if (dist(h, lastA) <= dist(h, lastB)) a = h
        else b = h
      } else if (lastA) {
        if (dist(h, lastA) <= 2.5 * lastA.len) a = h
        else b = h
      } else if (lastB) {
        if (dist(h, lastB) <= 2.5 * lastB.len) b = h
        else a = h
      } else a = h
    }
    if (a) lastA = a
    if (b) lastB = b
    pair.t.push(f.t)
    pair.a.push(a)
    pair.b.push(b)
  }
  return pair
}

// ------------------------------------------------------------------------------- utilities

const present = <T>(xs: readonly (T | null)[]): T[] => xs.filter((x): x is T => x !== null)

function median(values: readonly number[]): number {
  if (!values.length) return NaN
  const s = [...values].sort((p, q) => p - q)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Median hand length over a track (a steadier unit than any one frame's). */
const unit = (hands: readonly Hand[]): number => median(hands.map((h) => h.len))

const fraction = <T>(xs: readonly T[], test: (x: T) => boolean): number => (xs.length ? xs.filter(test).length / xs.length : 0)

/** At least three of the four fingers straight. */
const flat = (h: Hand): boolean => [1, 2, 3, 4].filter((i) => h.ext[i] >= 0.5).length >= 3
/** All four fingers straight (an open hand). */
const open = (h: Hand): boolean => [1, 2, 3, 4].filter((i) => h.ext[i] >= 0.5).length >= 4
/** Index straight, at least two of the other three fingers bent. */
const pointing = (h: Hand): boolean => h.ext[1] >= 0.5 && [2, 3, 4].filter((i) => h.ext[i] < 0.5).length >= 2
/** Y: pinky out, index / middle / ring mostly bent (the thumb is unreliable in 2D, so it is not required). */
const yShape = (h: Hand): boolean => h.ext[4] >= 0.5 && [1, 2, 3].filter((i) => h.ext[i] < 0.5).length >= 2

/**
 * Zig-zag strokes: how many monotonic runs of at least `amp` the series makes (the run in
 * progress counts once it reaches `amp`). Side to side twice is 2.
 */
export function strokeCount(values: readonly number[], amp: number): number {
  if (values.length < 2) return 0
  let dir = 0
  let lo = values[0]
  let hi = values[0]
  let ext = values[0]
  let n = 0
  for (const v of values) {
    if (dir === 0) {
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
      if (hi - lo >= amp) {
        dir = v === hi ? 1 : -1
        ext = v
        n = 1
      }
    } else if (dir === 1) {
      if (v > ext) ext = v
      else if (ext - v >= amp) {
        dir = -1
        ext = v
        n++
      }
    } else if (v < ext) ext = v
    else if (v - ext >= amp) {
      dir = 1
      ext = v
      n++
    }
  }
  return n
}

/** 3-point running median: removes single-frame landmark spikes. */
function smooth(values: readonly number[]): number[] {
  return values.map((v, i) => {
    if (i === 0 || i === values.length - 1) return v
    const [p, q, r] = [values[i - 1], v, values[i + 1]].sort((x, y) => x - y)
    void p
    void r
    return q
  })
}

const last = <T>(xs: readonly T[]): T => xs[xs.length - 1]

/** Whether a track jumps (moves faster than `maxSpeed` hand lengths / s between sightings) from time t0 on. */
function jumps(track: readonly (Hand | null)[], t0: number, L: number, maxSpeed: number): boolean {
  let prev: Hand | null = null
  for (const h of track) {
    if (!h || h.t < t0) continue
    if (prev && dist(h, prev) / L / (Math.max(h.t - prev.t, 1) / 1000) > maxSpeed) return true
    prev = h
  }
  return false
}

/** The track's hand at time t, or the nearest one seen within 200 ms. */
function nearestIn(track: readonly (Hand | null)[], t: number): Hand | null {
  let best: Hand | null = null
  for (const h of track) if (h && Math.abs(h.t - t) <= 200 && (!best || Math.abs(h.t - t) < Math.abs(best.t - t))) best = h
  return best
}

// ----------------------------------------------------------------------------------- OPEN

/**
 * OPEN: two flat hands side by side, then they swing apart. Fires when, within OPEN_MS, the
 * horizontal gap between the hands has grown by OPEN_SPREAD hand lengths from a start of at most
 * OPEN_START_GAP, each hand having moved outward, mostly sideways, both flat throughout.
 */
function openFires(history: readonly FrameSample[], { aspect }: StreamContext): boolean {
  const P = TUNING.open
  const frames = framesOf(history, aspect, P.ms)
  if (last(frames).hands.length !== 2) return false
  const pair = pairUp(frames)
  const both: { a: Hand; b: Hand }[] = []
  pair.a.forEach((a, i) => {
    const b = pair.b[i]
    if (a && b) both.push({ a, b })
  })
  if (both.length < 3) return false
  const end = last(both)
  const L = (unit(both.map((p) => p.a)) + unit(both.map((p) => p.b))) / 2
  // a stays on its side: orient so that "outward" is away from the other hand.
  const side = Math.sign(end.b.x - end.a.x) || 1
  const gapEnd = (side * (end.b.x - end.a.x)) / L
  for (let i = 0; i < both.length - 2; i++) {
    const start = both[i]
    const gapStart = (side * (start.b.x - start.a.x)) / L
    if (gapStart > P.startGap || gapEnd - gapStart < P.spread) continue
    const outA = (-side * (end.a.x - start.a.x)) / L
    const outB = (side * (end.b.x - start.b.x)) / L
    if (outA < P.each || outB < P.each) continue
    const drop = Math.max(Math.abs(end.a.y - start.a.y), Math.abs(end.b.y - start.b.y)) / L
    if (drop > P.drop * (gapEnd - gapStart)) continue
    const span = both.slice(i)
    // A real opening takes time and is continuous: a jump (tracking glitch, hands re-found
    // elsewhere) is no movement.
    if (end.a.t - start.a.t < P.minMs) continue
    if (jumps(pair.a, start.a.t, L, P.maxSpeed) || jumps(pair.b, start.b.t, L, P.maxSpeed)) continue
    if (fraction(span, (p) => flat(p.a) && flat(p.b)) < P.flatShare) continue
    if (fraction(span, (p) => p.a.dy < P.notDown && p.b.dy < P.notDown) < 0.6) continue
    // OPEN starts from two flat hands side by side, not from bunched fingertips (the end of MEETING).
    if (fraction(span.slice(0, 3), (p) => flat(p.a) && flat(p.b)) < P.startFlat) continue
    // ...and does not end palms up, wide apart (hands separating into WHAT).
    const tail = span.slice(-3)
    if (median(tail.flatMap((p) => [p.a.width, p.b.width])) > P.endWidth) continue
    return true
  }
  return false
}

// ---------------------------------------------------------------------------------- MUSIC

/**
 * MUSIC: the base forearm lies across the body; the other flat hand, fingers sideways, swings side
 * to side above it. Fires on the MUSIC_STROKES-th sideways stroke of the upper hand while the lower
 * hand holds still below it.
 */
function musicFires(history: readonly FrameSample[], { aspect }: StreamContext): boolean {
  const P = TUNING.music
  const frames = framesOf(history, aspect, P.ms)
  if (!last(frames).hands.length) return false
  const pair = pairUp(frames)
  for (const [dom, base] of [
    [pair.a, pair.b],
    [pair.b, pair.a]
  ] as const) {
    const d = present(dom)
    const b = present(base)
    if (d.length < 5 || b.length < P.baseFrames) continue
    if (!dom[dom.length - 1]) continue
    const L = unit(d)
    if (median(b.map((h) => h.y)) - median(d.map((h) => h.y)) < P.below * L) continue
    const bx = b.map((h) => h.x)
    const by = b.map((h) => h.y)
    if ((Math.max(...bx) - Math.min(...bx)) / L > P.baseStill || (Math.max(...by) - Math.min(...by)) / L > P.baseStill) continue
    if (fraction(d, flat) < P.flatShare) continue
    if (fraction(d, (h) => Math.abs(h.dx) >= P.sideways) < P.sidewaysShare) continue
    const xs = smooth(d.map((h) => h.x / L))
    const ys = smooth(d.map((h) => h.y / L))
    const sx = strokeCount(xs, P.amp)
    if (sx < P.strokes) continue
    if (strokeCount(ys, P.amp) > sx) continue
    return true
  }
  return false
}

// ----------------------------------------------------------------------------------- PLAY

/**
 * PLAY: both hands in Y, twisting or shaking at the wrist. Fires once each hand has gone back and
 * forth (in thumb-to-pinky angle or position) at least twice while both hold the Y.
 */
function twistStrokes(hands: readonly Hand[], L: number): number {
  const P = TUNING.play
  const angle: number[] = []
  let prev: number | null = null
  for (const h of hands) {
    let a = (Math.atan2(h.pts[20].y - h.pts[4].y, h.pts[20].x - h.pts[4].x) * 180) / Math.PI
    if (prev !== null) while (a - prev > 180) a -= 360
    if (prev !== null) while (a - prev < -180) a += 360
    angle.push(a)
    prev = a
  }
  const twist = strokeCount(smooth(angle), P.twistDeg)
  const sx = strokeCount(smooth(hands.map((h) => h.x / L)), P.shake)
  // Up / down shakes count only while small: a rise into view and a drop (NOW) are two big strokes.
  const ys = smooth(hands.map((h) => h.y / L))
  const sy = Math.max(...ys) - Math.min(...ys) <= P.yRange ? strokeCount(ys, P.shake) : 0
  return Math.max(twist, sx, sy)
}

function playFires(history: readonly FrameSample[], { aspect }: StreamContext): boolean {
  const P = TUNING.play
  const frames = framesOf(history, aspect, P.ms)
  if (last(frames).hands.length !== 2) return false
  const pair = pairUp(frames)
  const a = present(pair.a)
  const b = present(pair.b)
  if (a.length < 5 || b.length < 5) return false
  if (fraction(a, yShape) < P.yShare || fraction(b, yShape) < P.yShare) return false
  const L = (unit(a) + unit(b)) / 2
  const end = { a: last(a), b: last(b) }
  if (Math.abs(end.a.x - end.b.x) / L < P.gap) return false
  const ta = twistStrokes(a, L)
  const tb = twistStrokes(b, L)
  return Math.min(ta, tb) >= P.strokes && Math.max(ta, tb) >= P.strokesMax
}

// ----------------------------------------------------------------------------------- STOP

/**
 * STOP: the base hand flat, palm up; the other flat hand, on its edge, chops down onto it. Fires
 * when the edge-on hand has dropped STOP_DROP hand lengths within STOP_MS, mostly straight down,
 * and its lowest point has reached the base hand.
 */
function stopFires(history: readonly FrameSample[], { aspect }: StreamContext): boolean {
  const P = TUNING.stop
  const frames = framesOf(history, aspect, P.ms)
  if (!last(frames).hands.length) return false
  const pair = pairUp(frames)
  for (const [dom, base] of [
    [pair.a, pair.b],
    [pair.b, pair.a]
  ] as const) {
    const now = dom[dom.length - 1]
    if (!now) continue
    const d = present(dom)
    const b = present(base)
    if (d.length < 3 || !b.length) continue
    const L = unit(d)
    const top = d.reduce((p, h) => (h.y < p.y ? h : p), d[0])
    if ((now.y - top.y) / L < P.drop) continue
    if (Math.abs(now.x - top.x) > P.slant * (now.y - top.y)) continue
    const fall = d.filter((h) => h.t >= top.t)
    if (fraction(fall, flat) < P.flatShare || fraction(fall, (h) => h.width <= P.edgeWidth) < P.edgeShare) continue
    const bb = last(b)
    if (bb.y - top.y < P.baseBelow * L) continue
    // The base palm faces up, fingers forward or sideways: not an upright hand (EMAIL, WHAT's palm).
    if (median(b.map((h) => h.dy)) < P.baseUpright) continue
    const bottom = Math.max(...now.pts.map((p) => p.y))
    const baseTop = Math.min(...bb.pts.map((p) => p.y))
    if (bottom < baseTop - P.reach * L) continue
    if (Math.abs(now.x - bb.x) > P.side * L) continue
    return true
  }
  return false
}

// ----------------------------------------------------------------------------------- TIME

/**
 * TIME: the pointing index taps the back of the base wrist. Fires on the rebound of a tap (the
 * fingertip down then up by TIME_TAP hand lengths) while it is near the base hand, which is below.
 */
function timeFires(history: readonly FrameSample[], { aspect }: StreamContext): boolean {
  const P = TUNING.time
  const frames = framesOf(history, aspect, P.ms)
  if (last(frames).hands.length !== 2) return false
  const pair = pairUp(frames)
  for (const [dom, base] of [
    [pair.a, pair.b],
    [pair.b, pair.a]
  ] as const) {
    const d = present(dom)
    const b = present(base)
    if (d.length < 5 || b.length < 3) continue
    const L = unit(d)
    if (fraction(d, pointing) < P.pointShare) continue
    const bb = last(b)
    const now = last(d)
    if (median(b.map((h) => h.y)) - median(d.map((h) => h.y)) < P.below * L) continue
    const by = b.map((h) => h.y)
    if ((Math.max(...by) - Math.min(...by)) / L > P.baseStill) continue
    // The base forearm lies across the body: its hand is not upright, and it is not pointing too.
    if (median(b.map((h) => h.dy)) < P.baseUpright) continue
    if (fraction(b, pointing) > P.basePointing) continue
    const tip = now.pts[8]
    const near = Math.min(...bb.pts.map((p) => Math.hypot(p.x - tip.x, p.y - tip.y))) / L
    if (near > P.near) continue
    const ty = smooth(d.map((h) => h.pts[8].y / L))
    if (strokeCount(ty, P.tap) < P.strokes) continue
    return true
  }
  return false
}

// ---------------------------------------------------------------------------------- EMAIL

/**
 * EMAIL: the base hand in C / O (or flat), the pointing index slides through it. Fires when the
 * index hand has moved EMAIL_SLIDE hand lengths toward and past the base hand's fingers.
 */
function emailFires(history: readonly FrameSample[], { aspect }: StreamContext): boolean {
  const P = TUNING.email
  const frames = framesOf(history, aspect, P.ms)
  if (last(frames).hands.length !== 2) return false
  const pair = pairUp(frames)
  for (const [dom, base] of [
    [pair.a, pair.b],
    [pair.b, pair.a]
  ] as const) {
    const d = present(dom)
    const b = present(base)
    if (d.length < 5 || b.length < 5) continue
    const L = unit(d)
    if (fraction(d, pointing) < P.pointShare) continue
    if (fraction(b, pointing) > P.basePointing) continue
    // The base hand stands up (C / O or flat, fingers up), and holds still.
    if (median(b.map((h) => h.dy)) > P.baseUpright) continue
    const bx = b.map((h) => h.x)
    const by = b.map((h) => h.y)
    if (Math.max(Math.max(...bx) - Math.min(...bx), Math.max(...by) - Math.min(...by)) / L > P.baseStill) continue
    const now = last(d)
    const bb = last(b)
    const tip = now.pts[8]
    const near = Math.min(...bb.pts.map((p) => Math.hypot(p.x - tip.x, p.y - tip.y))) / L
    if (near > P.near) continue
    // The index slid through the base: seen from the front, the fingertip travels across the base
    // hand (relative to it), most of it while close.
    const rel = d.flatMap((h) => {
      const at = nearestIn(base, h.t)
      return at ? [{ x: (h.pts[8].x - at.x) / L, y: (h.pts[8].y - at.y) / L }] : []
    })
    if (rel.length < 4) continue
    const rx = Math.max(...rel.map((p) => p.x)) - Math.min(...rel.map((p) => p.x))
    const ry = Math.max(...rel.map((p) => p.y)) - Math.min(...rel.map((p) => p.y))
    if (Math.max(rx, ry) < P.slide) continue
    // WHAT's other form brushes the index down the palm: mostly vertical. EMAIL goes through, across.
    if (rx < P.across * ry) continue
    const start = d[0]
    const toward = Math.sign(bb.x - start.x)
    if ((toward * (now.x - start.x)) / L < P.toward) continue
    return true
  }
  return false
}

// ----------------------------------------------------------------------------------- WHAT

/**
 * WHAT: both open hands, palms up, apart at about the same height, shaking side to side a little.
 * Fires once both hands have made WHAT_STROKES sideways strokes.
 */
function whatFires(history: readonly FrameSample[], { aspect }: StreamContext): boolean {
  const P = TUNING.what
  const frames = framesOf(history, aspect, P.ms)
  if (last(frames).hands.length !== 2) return false
  const pair = pairUp(frames)
  const L0 = (unit(present(pair.a)) + unit(present(pair.b))) / 2
  // Only the stretch since the hands were last close together or uneven counts: the shake happens
  // with them apart (after MEETING, say, the hands first separate, which is no shake).
  let from = 0
  for (let i = 0; i < pair.t.length; i++) {
    const [p, q] = [pair.a[i], pair.b[i]]
    if (p && q && (Math.abs(p.x - q.x) / L0 < P.gap || Math.abs(p.y - q.y) / L0 > P.height)) from = i + 1
  }
  const a = present(pair.a.slice(from))
  const b = present(pair.b.slice(from))
  if (a.length < 5 || b.length < 5) return false
  if (fraction(a, open) < P.openShare || fraction(b, open) < P.openShare) return false
  const L = (unit(a) + unit(b)) / 2
  if (median(a.map((h) => h.width)) < P.palmUp || median(b.map((h) => h.width)) < P.palmUp) return false
  const sa = strokeCount(smooth(a.map((h) => h.x / L)), P.amp)
  const sb = strokeCount(smooth(b.map((h) => h.x / L)), P.amp)
  if (Math.min(sa, sb) < P.strokes || Math.max(sa, sb) < P.strokesMax) return false
  // The shake must start inside the window, so one long shake is one WHAT (the matcher clears the
  // history when a word fires): before it, the hands were close (from > 0), out of view, or still.
  if (from > 0) return true
  const t0 = pair.t[0]
  const early = pair.t.map((t, i) => (t - t0 <= P.onsetMs ? i : -1)).filter((i) => i >= 0)
  if (early.some((i) => !pair.a[i] || !pair.b[i])) return true
  const still = (track: readonly (Hand | null)[]): boolean => {
    const xs = early.flatMap((i) => (track[i] ? [track[i]!.x / L] : []))
    return Math.max(...xs) - Math.min(...xs) < P.amp
  }
  return still(pair.a) && still(pair.b)
}

// --------------------------------------------------------------------------------- PLEASE

/**
 * PLEASE: a flat hand on the chest, fingers across the body, circling. Fires once the palm has
 * wound PLEASE_TURN degrees around the middle of its path, below the face when a face is known.
 */
/**
 * Signed degrees the palm winds around the middle of its path, mirrored for the hand's side so the
 * sign is anatomical: negative is PLEASE's direction for either hand, HAPPY's brushing loop winds
 * the other way. (Image y points down; the side is the window's majority handedness vote.)
 */
export function winding(hands: readonly Hand[]): number {
  const cx = hands.reduce((s, h) => s + h.x, 0) / hands.length
  const cy = hands.reduce((s, h) => s + h.y, 0) / hands.length
  let total = 0
  let prev: number | null = null
  for (const h of hands) {
    const a = Math.atan2(h.y - cy, h.x - cx)
    if (prev !== null) {
      let d = a - prev
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      total += d
    }
    prev = a
  }
  const side = hands.reduce((s, h) => s + h.right, 0) >= 0 ? -1 : 1
  return (total * side * 180) / Math.PI
}

function pleaseFires(history: readonly FrameSample[], { aspect, face }: StreamContext): boolean {
  const P = TUNING.please
  const frames = framesOf(history, aspect, P.ms)
  if (!last(frames).hands.length) return false
  const pair = pairUp(frames)
  for (const [track, other] of [
    [pair.a, pair.b],
    [pair.b, pair.a]
  ] as const) {
    if (!track[track.length - 1]) continue
    const d = present(track)
    if (d.length < 8) continue
    const L = unit(d)
    if (fraction(d, flat) < P.flatShare) continue
    if (fraction(d, (h) => Math.abs(h.dx) >= P.sideways) < P.sidewaysShare) continue
    if (face) {
      const fy = median(d.map((h) => h.y))
      const fx = median(d.map((h) => h.x)) / aspect
      if (fy < face.cy + P.chestTop * face.h || fy > face.cy + P.chestBottom * face.h || Math.abs(fx - face.cx) > P.chestSide * face.w) continue
    }
    // The other hand, if seen, is not moving much (NIGHT, MAIL and two-handed signs move both).
    const o = present(other)
    if (o.length >= 3) {
      const ox = o.map((h) => h.x)
      const oy = o.map((h) => h.y)
      if (Math.max(Math.max(...ox) - Math.min(...ox), Math.max(...oy) - Math.min(...oy)) / L > P.otherStill) continue
    }
    const xs = smooth(d.map((h) => h.x))
    const ys = smooth(d.map((h) => h.y))
    const rx = (Math.max(...xs) - Math.min(...xs)) / L
    const ry = (Math.max(...ys) - Math.min(...ys)) / L
    if (rx < P.minX || ry < P.minY || rx > P.maxRange || ry > P.maxRange) continue
    // PLEASE circles one way; HAPPY's brushing loop on the chest winds the other way.
    if (-winding(d) < P.turn) continue
    return true
  }
  return false
}

// ---------------------------------------------------------------------------------- rules

/** Every rule, validated or not (the tuning harness runs them all). Most specific first. */
export const ALL_RULES: StreamRule[] = [
  { word: 'time', hands: 2, fires: timeFires },
  { word: 'email', hands: 2, fires: emailFires },
  { word: 'stop', hands: 2, fires: stopFires },
  { word: 'music', hands: 2, fires: musicFires },
  { word: 'play', hands: 2, fires: playFires },
  { word: 'what', hands: 2, fires: whatFires },
  { word: 'open', hands: 2, fires: openFires },
  { word: 'please', hands: 1, fires: pleaseFires }
]

/**
 * The words that reach about 60% recall on real signers with low false fires
 * (twoHandSigns.eval.test.ts). Not yet, so off: MUSIC (its base forearm is mostly out of view in
 * the clips) and STOP (about 40% on clips tracked like the app, and the most false fires).
 */
const VALIDATED = new Set(['time', 'email', 'play', 'what', 'open', 'please'])

/** The rules the app runs: base-hand signs first, then the two-hand movements, then PLEASE. */
export const TWO_HAND_RULES: StreamRule[] = ALL_RULES.filter((r) => VALIDATED.has(r.word))
