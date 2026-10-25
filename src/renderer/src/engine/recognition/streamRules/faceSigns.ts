import type { HandShape } from '../../gestures/handShape'
import type { FrameSample } from '../../types'
import { faceFor } from './face'
import { dist, faceDist, liveTracks, onFace, otherHandNear, type HandFeat, type Pt, type Track } from './handTracks'
import type { FaceBox, StreamContext, StreamRule } from './types'

/*
 * Streaming rules for one-handed ASL signs made at the face (THANK YOU, TOMORROW, MOM, DAD,
 * CALL) or with a small repeated movement (YES, NO). Each rule looks at the recent history every
 * frame and fires as soon as the sign's movement or contact is far enough along.
 *
 * Every rule needs a movement or a contact, never a held shape alone, because held shapes are
 * fastASL's control gestures (fist, open palm, finger counts, thumbs up, peace):
 *  - THANK YOU, TOMORROW: a contact at the face, then the hand leaves it (down / forward).
 *  - MOM, DAD, CALL: the hand arrives at the face from elsewhere and the contact holds briefly.
 *  - YES: the fist nods (goes down and up again) at least twice.
 *  - NO: two straight fingers snap shut onto the thumb.
 *
 * Positions at the face are in face units (faceBox: ±0.5 at the box edges, v down: chin ≈ +0.5,
 * mouth ≈ +0.25, eyes ≈ -0.1, forehead top ≈ -0.5). Either hand works: left/right offsets use
 * |u|. Measured on ASL Citizen clips; faceSigns.eval.test.ts has the numbers.
 */

/** Tuning constants, in face heights (fh), palm lengths (pl) or ms. */
export const FACE_SIGN_PARAMS = {
  shape: {
    /** Finger extension (handShape.analyzeHand, 0 curled .. 1 straight) that counts as straight. */
    on: 0.6,
    /** ... that counts as bent, for fists and folded fingers. */
    off: 0.4,
    /** A finger of a straight-fingered hand may not drop below this. */
    floor: 0.35
  },
  /** Handshape flicker forgiven while a hand moves away from a contact (ms). */
  flickerMs: 120,
  oneHand: {
    /** A one-handed sign: no other hand within this many palm lengths ... */
    near: 2.5,
    /** ... during this long before firing (two-handed signs bring the hands together). */
    ms: 600
  },
  thankYou: {
    /** Fingertips at the mouth / chin: |u| and v range. */
    tipU: 0.5,
    tipV: [0.0, 0.8] as [number, number],
    /** Fingers point up at least this much (pointing.y is -1 straight up). */
    upAtContact: -0.25,
    /** At the contact the fingers slant in toward the face's midline by at least this much (pointing.x). */
    inward: 0.2,
    /** While moving away: still not pointing sideways or down (BAD turns the palm down). */
    upWhileMoving: -0.1,
    /** When it fires, the fingers still point clearly up (BAD has turned them sideways by then). */
    upAtEnd: -0.55,
    /** Require the back of the hand toward the camera at the contact (the wake palm faces it). */
    backOfHand: true,
    /** The fingertips pause at the lips this long (ms), moving less than `pause` (fh). */
    pauseMs: 100,
    pause: 0.1,
    /** The contact is at most this old. */
    contactMs: 900,
    /** Palm drop (fh) and fingertip travel (fh) from the contact. */
    drop: 0.4,
    travel: 0.35
  },
  tomorrow: {
    /** Thumb tip at the cheek / jaw: |u| range and v range. */
    thumbU: [0.1, 0.8] as [number, number],
    thumbV: [-0.2, 0.6] as [number, number],
    /**
     * At the cheek the thumb lies along the fist (A hand), so it reads bent or half out; a thumb
     * sticking straight out there is YESTERDAY's or a thumbs-up.
     */
    thumbExt: 0.7,
    contactMs: 900,
    /**
     * The forward arc, seen from the front: the fist pivots on the thumb, so the palm drops (fh)
     * while the thumb tip stays near cheek height. Lowering the hand after a sign drops both.
     */
    drop: 0.2,
    /** Palm drop minus thumb-tip drop (fh). */
    pivot: 0.15,
    /** The thumb tip may drop at most this much (fh) ... */
    thumbDrop: 0.2,
    /** ... and must still be above this face height at the end. */
    thumbEndV: 0.5
  },
  /**
   * MOM / DAD: thumb tip zone, and how squarely the palm may face the camera (|palmFacing|, only
   * when the landmarks have depth). The sign's palm faces sideways; a wake palm faces the camera
   * (real open palms: median 0.94), and so do most C hands at the mouth (DRINK).
   */
  mom: { thumbU: 0.45, thumbV: [0.2, 0.75] as [number, number], facingMax: 0.85 },
  dad: { thumbU: 0.55, thumbV: [-0.85, -0.15] as [number, number], facingMax: 0.9 },
  /** Landmark z spread (wrist-relative units) above which the hand has real depth and palmFacing means something. */
  depthMin: 0.01,
  fiveAtFace: {
    /** Fingers up at least this much. */
    up: -0.4,
    /** Thumb extension: at least half out. */
    thumb: 0.15,
    /** A spread 5: the index tip at least this far from the thumb tip (palm lengths) ... */
    gap: 0.6,
    /** ... and this far above it (face heights). C and flat-O hands at the mouth (DRINK, EAT) bunch up. */
    rise: 0.25,
    /** Every finger at least this straight (a C hand's curved fingers read 0.6-0.9). */
    finger: 0.85
  },
  call: {
    /** Pinky tip near the mouth / chin. */
    pinkyU: 0.6,
    pinkyV: [0.1, 0.95] as [number, number],
    /** Thumb tip up by the cheek / ear, above the pinky tip. */
    thumbU: 0.2,
    thumbV: [-0.45, 0.45] as [number, number],
    thumbAbovePinky: 0.15
  },
  arrive: {
    /** The contact holds this long ... */
    dwellMs: 150,
    /** ... after the hand came from at least this far away (fh) ... */
    from: 0.4,
    /** ... within this long before the contact started. */
    withinMs: 1000,
    /** A contact may skip this long of frames (a flicker of the handshape or tracking). */
    graceMs: 100
  },
  yes: {
    /** One nod: the knuckles go down and back up by this much (palm lengths). */
    swing: 0.25,
    /** Swings (down, up, down ...) needed. */
    swings: 3,
    /** Within this long. */
    windowMs: 1200,
    /** Share of the window's frames that must be a fist. */
    fistShare: 0.8
  },
  no: {
    /** Open: index tip at least this far from the thumb tip (palm lengths). */
    open: 0.9,
    /** Shut: index and middle tips this close to the thumb tip (palm lengths). */
    shut: 0.45,
    /** Open to shut within this long. */
    snapMs: 400,
    /** The palm may drift this much (palm lengths) during the snap. */
    drift: 0.8
  }
}

const P = FACE_SIGN_PARAMS
const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const

// ---------------------------------------------------------------------------------------------
// Handshapes, from analyzeHand's per-digit extension.

const ext = (s: HandShape, d: keyof HandShape['extension']): number => s.extension[d]

/** Four straight fingers (B or 5): three clearly straight, none bent. */
export function straightFingers(s: HandShape): boolean {
  let on = 0
  for (const f of FINGERS) {
    const e = ext(s, f)
    if (e < P.shape.floor) return false
    if (e >= P.shape.on) on++
  }
  return on >= 3
}

/** Four bent fingers (S, A or a fist): three clearly bent, none straight. */
export function bentFingers(s: HandShape): boolean {
  let off = 0
  for (const f of FINGERS) {
    const e = ext(s, f)
    if (e >= P.shape.on) return false
    if (e <= P.shape.off) off++
  }
  return off >= 3
}

/** 5 hand: straight fingers and the thumb out. */
export function fiveHand(s: HandShape): boolean {
  return straightFingers(s) && ext(s, 'thumb') >= P.fiveAtFace.thumb
}

/** Y (or I) hand: pinky straight, index / middle / ring bent. The thumb is not checked: pressed to the cheek it often reads bent. */
export function yHand(s: HandShape): boolean {
  return ext(s, 'pinky') >= P.shape.on && ext(s, 'index') <= P.shape.off && ext(s, 'middle') <= P.shape.off && ext(s, 'ring') <= P.shape.off + 0.1
}

/** NO's open shape: index and middle straight, ring and pinky bent. */
export function twoFingers(s: HandShape): boolean {
  return ext(s, 'index') >= P.shape.on && ext(s, 'middle') >= P.shape.on && ext(s, 'ring') <= P.shape.off + 0.05 && ext(s, 'pinky') <= P.shape.off + 0.05
}

// ---------------------------------------------------------------------------------------------
// Movement patterns.

/**
 * Contact, then away: some frame in the last `contactMs` is a contact, the frames since keep the
 * handshape (up to P.flickerMs of frames that don't are forgiven: fingers flicker mid-movement),
 * and the hand has moved far enough from it now.
 */
function contactThenMove(
  track: Track,
  contactMs: number,
  contact: (f: HandFeat, i: number) => boolean,
  keep: (f: HandFeat) => boolean,
  moved: (from: HandFeat, now: HandFeat) => boolean
): boolean {
  const now = track[track.length - 1]
  let missed = 0
  for (let i = track.length - 2; i >= 0; i--) {
    const f = track[i]
    if (now.t - f.t > contactMs) break
    if (contact(f, i) && moved(f, now)) return true
    if (!keep(f) && (missed += track[i + 1].t - f.t) > P.flickerMs) break
  }
  return false
}

/**
 * Arrive and hold: the last `dwellMs` all pass `at` (gaps up to graceMs forgiven), and the hand got
 * there just before: within `withinMs` before the hold, its `key` point was at least `from` face
 * heights from where it is now, or the hand only came into view then (it rose into the frame;
 * `since` is the history's first frame, so a hand that was there all along doesn't count).
 */
function arriveAndDwell(
  track: Track,
  face: FaceBox,
  aspect: number,
  since: number,
  at: (f: HandFeat) => boolean,
  key: (f: HandFeat) => Pt
): boolean {
  const now = track[track.length - 1]
  if (!at(now)) return false
  let start = track.length - 1
  let lastOk = now.t
  for (let i = track.length - 2; i >= 0; i--) {
    const f = track[i]
    if (at(f)) {
      start = i
      lastOk = f.t
    } else if (lastOk - f.t > P.arrive.graceMs) break
  }
  const first = track[start]
  if (now.t - first.t < P.arrive.dwellMs) return false
  if (track[0].t > since && first.t - track[0].t <= P.arrive.withinMs) return true
  const anchor = key(now)
  for (let i = start - 1; i >= 0; i--) {
    const f = track[i]
    if (first.t - f.t > P.arrive.withinMs) break
    if (faceDist(key(f), anchor, face, aspect) >= P.arrive.from) return true
  }
  return false
}

/**
 * The back of the hand faces the camera (the palm faces the signer), for a hand beside the face.
 * Label-free: MediaPipe's handedness labels assume a mirrored image and have flipped between
 * releases, so the hand is taken from its side of the face (in the raw image the signer's right
 * hand is on the left), and the palm side from the winding of wrist, index and pinky knuckles.
 */
export function backToCamera(f: HandFeat, face: FaceBox, aspect: number): boolean {
  const lm = f.hand.landmarks
  const ax = (lm[5].x - lm[0].x) * aspect
  const ay = lm[5].y - lm[0].y
  const bx = (lm[17].x - lm[0].x) * aspect
  const by = lm[17].y - lm[0].y
  const winding = ax * by - ay * bx
  // A right hand with its palm to the camera winds negative (y down); the back of it, positive.
  const rightHand = onFace(f.palm, face).u < 0
  return rightHand ? winding > 0 : winding < 0
}

/** Whether the middle fingertip stayed within `within` (image height units) for `ms` up to track[i]. */
function pausedBefore(track: Track, i: number, ms: number, within: number, aspect: number): boolean {
  if (ms <= 0) return true
  const at = track[i]
  for (let j = i - 1; j >= 0; j--) {
    const f = track[j]
    if (dist(f.middle, at.middle, aspect) > within) return false
    if (at.t - f.t >= ms) return true
  }
  return false
}

/** Whether the hand's landmarks carry real depth (MediaPipe tasks do; flattened recordings don't). */
function hasDepth(f: HandFeat): boolean {
  let lo = Infinity
  let hi = -Infinity
  for (const p of f.hand.landmarks) {
    if (p.z < lo) lo = p.z
    if (p.z > hi) hi = p.z
  }
  return hi - lo >= P.depthMin
}

const inRange = (x: number, [lo, hi]: readonly [number, number]): boolean => x >= lo && x <= hi

// ---------------------------------------------------------------------------------------------
// The rules.

/** Face rules share this: the live tracks and the face, or nothing when there is no face. */
function withFace(
  history: readonly FrameSample[],
  ctx: StreamContext,
  test: (track: Track, face: FaceBox, since: number) => boolean
): boolean {
  const face = faceFor(history, ctx)
  if (!face) return false
  const tracks = liveTracks(history, ctx.aspect)
  const since = history[0].t
  return tracks.some((track) => test(track, face, since) && !otherHandNear(track, tracks, P.oneHand.ms, P.oneHand.near, ctx.aspect))
}

export const thankYou: StreamRule = {
  word: 'thank you',
  hands: 1,
  fires(history, ctx) {
    const c = P.thankYou
    return withFace(history, ctx, (track, face) =>
      contactThenMove(
        track,
        c.contactMs,
        (f, i) => {
          if (!straightFingers(f.shape) || f.shape.pointing.y > c.upAtContact) return false
          // The hand comes from the side, fingers slanting in toward the mouth, back of the hand to the camera.
          const side = onFace(f.palm, face).u < 0 ? 1 : -1
          if (side * f.shape.pointing.x < c.inward) return false
          if (c.backOfHand && !backToCamera(f, face, ctx.aspect)) return false
          const tip = onFace(f.index.y < f.middle.y ? f.index : f.middle, face)
          if (Math.abs(tip.u) > c.tipU || !inRange(tip.v, c.tipV)) return false
          // The fingertips rest at the lips for a moment before the hand moves off.
          return pausedBefore(track, i, c.pauseMs, c.pause * face.h, ctx.aspect)
        },
        (f) => straightFingers(f.shape) && f.shape.pointing.y <= c.upWhileMoving,
        (from, now) =>
          straightFingers(now.shape) &&
          now.shape.pointing.y <= c.upAtEnd &&
          (now.palm.y - from.palm.y) / face.h >= c.drop &&
          faceDist(now.middle, from.middle, face, ctx.aspect) >= c.travel
      )
    )
  }
}

export const tomorrow: StreamRule = {
  word: 'tomorrow',
  hands: 1,
  fires(history, ctx) {
    const c = P.tomorrow
    return withFace(history, ctx, (track, face) =>
      contactThenMove(
        track,
        c.contactMs,
        (f) => {
          if (!bentFingers(f.shape) || ext(f.shape, 'thumb') > c.thumbExt) return false
          const th = onFace(f.thumb, face)
          return inRange(Math.abs(th.u), c.thumbU) && inRange(th.v, c.thumbV)
        },
        (f) => bentFingers(f.shape),
        (from, now) => {
          if (!bentFingers(now.shape)) return false
          const palmDrop = (now.palm.y - from.palm.y) / face.h
          const thumbDrop = (now.thumb.y - from.thumb.y) / face.h
          return (
            palmDrop >= c.drop &&
            palmDrop - thumbDrop >= c.pivot &&
            thumbDrop <= c.thumbDrop &&
            onFace(now.thumb, face).v <= c.thumbEndV
          )
        }
      )
    )
  }
}

function fiveAtFace(zone: () => { thumbU: number; thumbV: readonly [number, number]; facingMax: number }) {
  return (history: readonly FrameSample[], ctx: StreamContext): boolean =>
    withFace(history, ctx, (track, face, since) =>
      arriveAndDwell(
        track,
        face,
        ctx.aspect,
        since,
        (f) => {
          const c = P.fiveAtFace
          if (!fiveHand(f.shape) || f.shape.pointing.y > c.up) return false
          if (FINGERS.some((d) => ext(f.shape, d) < c.finger)) return false
          if (dist(f.index, f.thumb, ctx.aspect) < c.gap * f.scale || (f.thumb.y - f.index.y) / face.h < c.rise) return false
          const th = onFace(f.thumb, face)
          const z = zone()
          if (Math.abs(th.u) > z.thumbU || !inRange(th.v, z.thumbV)) return false
          return !hasDepth(f) || Math.abs(f.shape.palmFacing) <= z.facingMax
        },
        (f) => f.thumb
      )
    )
}

export const mom: StreamRule = { word: 'mom', hands: 1, fires: fiveAtFace(() => P.mom) }
export const dad: StreamRule = { word: 'dad', hands: 1, fires: fiveAtFace(() => P.dad) }

export const call: StreamRule = {
  word: 'call',
  hands: 1,
  fires(history, ctx) {
    const c = P.call
    return withFace(history, ctx, (track, face, since) =>
      arriveAndDwell(
        track,
        face,
        ctx.aspect,
        since,
        (f) => {
          if (!yHand(f.shape)) return false
          const pk = onFace(f.pinky, face)
          const th = onFace(f.thumb, face)
          return (
            Math.abs(pk.u) <= c.pinkyU &&
            inRange(pk.v, c.pinkyV) &&
            Math.abs(th.u) >= c.thumbU &&
            inRange(th.v, c.thumbV) &&
            pk.v - th.v >= c.thumbAbovePinky
          )
        },
        (f) => f.palm
      )
    )
  }
}

/**
 * YES: a fist whose knuckles go down and up (the wrist nodding, or the whole fist bobbing). The
 * knuckle height is measured in the track's largest palm length, so a fist tipping toward the
 * camera (which shortens the palm in the image) still reads as a nod.
 */
export const yes: StreamRule = {
  word: 'yes',
  hands: 1,
  fires(history, ctx) {
    const c = P.yes
    return liveTracks(history, ctx.aspect).some((track) => {
      const now = track[track.length - 1]
      if (!bentFingers(now.shape)) return false
      const recent = track.filter((f) => now.t - f.t <= c.windowMs)
      if (recent.length < 4) return false
      if (recent.filter((f) => bentFingers(f.shape)).length < c.fistShare * recent.length) return false
      const unit = Math.max(...recent.map((f) => f.scale))
      return swings(recent.map((f) => f.knuckles.y / unit), c.swing) >= c.swings
    })
  }
}

/** Alternating moves of at least `amount` in a signal (a zig-zag count with hysteresis). */
export function swings(values: readonly number[], amount: number): number {
  let count = 0
  let dir = 0
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v > hi) hi = v
    if (v < lo) lo = v
    if (dir >= 0 && hi - v >= amount && (dir > 0 || count === 0)) {
      // Came down far enough from the high point (or the first move was down).
      dir = -1
      count++
      lo = v
    } else if (dir <= 0 && v - lo >= amount) {
      dir = 1
      count++
      hi = v
    }
  }
  return count
}

/**
 * NO: the index and middle fingers, straight and together, snap shut onto the thumb. Fires on the
 * first snap: open (index tip well away from the thumb tip) to shut (index and middle tips at the
 * thumb tip) within snapMs, ring and pinky bent throughout, the palm roughly in place.
 */
export const no: StreamRule = {
  word: 'no',
  hands: 1,
  fires(history, ctx) {
    const c = P.no
    const a = ctx.aspect
    return liveTracks(history, a).some((track) => {
      const now = track[track.length - 1]
      const s = now.shape
      if (ext(s, 'ring') > P.shape.off + 0.1 || ext(s, 'pinky') > P.shape.off + 0.1) return false
      const unit = now.scale
      if (dist(now.index, now.thumb, a) > c.shut * unit || dist(now.middle, now.thumb, a) > (c.shut + 0.1) * unit) return false
      for (let i = track.length - 2; i >= 0; i--) {
        const f = track[i]
        if (now.t - f.t > c.snapMs) break
        if (ext(f.shape, 'ring') > P.shape.off + 0.1 || ext(f.shape, 'pinky') > P.shape.off + 0.1) return false
        if (twoFingers(f.shape) && dist(f.index, f.thumb, a) >= c.open * f.scale) {
          return dist(f.palm, now.palm, a) <= c.drift * Math.max(f.scale, unit)
        }
      }
      return false
    })
  }
}

/**
 * The validated face signs, most specific first (the streaming matcher takes the first rule that
 * fires). Rules are added here once they pass faceSigns.eval.test.ts.
 */
export const FACE_RULES: StreamRule[] = [tomorrow, call, mom, dad]

/** Every rule in this file, validated or not (for the eval and the tests). */
export const ALL_FACE_RULES: StreamRule[] = [thankYou, tomorrow, mom, dad, call, no, yes]
