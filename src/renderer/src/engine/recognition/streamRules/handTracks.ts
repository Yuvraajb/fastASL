import type { Handedness } from '@shared/types'
import { analyzeHand, type HandShape } from '../../gestures/handShape'
import type { FrameSample, HandSample } from '../../types'
import type { FaceBox } from './types'

/*
 * Per-hand tracks over a stream history, with the measurements the face-sign rules use.
 *
 * Hands are linked frame to frame by position, not by MediaPipe's handedness label (it flips now
 * and then mid-sign), so one hand stays one track. Measurements are cached per HandSample object:
 * every rule sees the same frames every frame, so each hand is analyzed once, not once per rule
 * per frame.
 */

/** A point in normalized image coordinates (x: fraction of the width, y: of the height). */
export interface Pt {
  x: number
  y: number
}

/** One hand in one frame, measured. */
export interface HandFeat {
  t: number
  hand: HandSample
  label: Handedness
  shape: HandShape
  /** Palm centre: mean of the wrist and the four finger knuckles. */
  palm: Pt
  /** Mean of the four finger knuckles (MCPs). */
  knuckles: Pt
  wrist: Pt
  thumb: Pt
  index: Pt
  middle: Pt
  ring: Pt
  pinky: Pt
  /** Wrist -> middle knuckle in the image plane, as a fraction of the image height. */
  scale: number
}

const PALM = [0, 5, 9, 13, 17] as const
const KNUCKLES = [5, 9, 13, 17] as const

const cache = new WeakMap<HandSample, { aspect: number; feat: HandFeat }>()

function mean(lm: HandSample['landmarks'], idx: readonly number[]): Pt {
  let x = 0
  let y = 0
  for (const i of idx) {
    x += lm[i].x
    y += lm[i].y
  }
  return { x: x / idx.length, y: y / idx.length }
}

/** The hand measured (cached per HandSample and aspect). Null for a malformed hand. */
export function measure(hand: HandSample, t: number, aspect: number): HandFeat | null {
  const hit = cache.get(hand)
  if (hit && hit.aspect === aspect) return hit.feat.t === t ? hit.feat : { ...hit.feat, t }
  const lm = hand.landmarks
  if (lm.length !== 21 || !lm.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null
  const at = (i: number): Pt => ({ x: lm[i].x, y: lm[i].y })
  const scale = Math.hypot((lm[9].x - lm[0].x) * aspect, lm[9].y - lm[0].y)
  if (!(scale > 1e-6)) return null
  const feat: HandFeat = {
    t,
    hand,
    label: hand.handedness,
    shape: analyzeHand(hand, aspect),
    palm: mean(lm, PALM),
    knuckles: mean(lm, KNUCKLES),
    wrist: at(0),
    thumb: at(4),
    index: at(8),
    middle: at(12),
    ring: at(16),
    pinky: at(20),
    scale
  }
  cache.set(hand, { aspect, feat })
  return feat
}

/** Image distance between two points in units of the image height (x scaled by the aspect). */
export function dist(a: Pt, b: Pt, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y)
}

/** A point in face units: (0, 0) at the box centre, ±0.5 at its edges (x across, y down). */
export interface FacePt {
  u: number
  v: number
}

export function onFace(p: Pt, face: FaceBox): FacePt {
  return { u: (p.x - face.cx) / face.w, v: (p.y - face.cy) / face.h }
}

/** Distance between two points in face heights. */
export function faceDist(a: Pt, b: Pt, face: FaceBox, aspect: number): number {
  return dist(a, b, aspect) / face.h
}

/** A hand followed over the history, oldest sample first (frames where it was lost are skipped). */
export type Track = HandFeat[]

/** A hand missing longer than this starts a new track when it comes back. */
const TRACK_GAP_MS = 300
/** A hand further than this (palm lengths) from where a track was is a different hand. */
const TRACK_JUMP = 3

/**
 * The hands of the history as tracks, linked by palm position. Only tracks that include the
 * current frame are returned: a rule can only fire on a hand that is in view now.
 */
export function liveTracks(history: readonly FrameSample[], aspect: number): Track[] {
  const tracks: Track[] = []
  for (const frame of history) {
    const feats = frame.hands.map((h) => measure(h, frame.t, aspect)).filter((f): f is HandFeat => f !== null)
    const open = tracks.filter((tr) => frame.t - tr[tr.length - 1].t <= TRACK_GAP_MS && tr[tr.length - 1].t < frame.t)
    // Greedy nearest pairs, so two hands in view never trade tracks.
    const pairs: { f: HandFeat; tr: Track; d: number }[] = []
    for (const f of feats) {
      for (const tr of open) {
        const last = tr[tr.length - 1]
        const d = dist(f.palm, last.palm, aspect) / Math.max(f.scale, last.scale)
        if (d <= TRACK_JUMP) pairs.push({ f, tr, d })
      }
    }
    pairs.sort((a, b) => a.d - b.d)
    const usedF = new Set<HandFeat>()
    const usedT = new Set<Track>()
    for (const { f, tr } of pairs) {
      if (usedF.has(f) || usedT.has(tr)) continue
      tr.push(f)
      usedF.add(f)
      usedT.add(tr)
    }
    for (const f of feats) if (!usedF.has(f)) tracks.push([f])
  }
  const now = history[history.length - 1]?.t
  return tracks.filter((tr) => tr[tr.length - 1].t === now)
}

/**
 * Whether another hand came within `near` palm lengths of this track's hand during the last
 * `ms`: a two-handed sign, not this one-handed one.
 */
export function otherHandNear(track: Track, tracks: readonly Track[], ms: number, near: number, aspect: number): boolean {
  const now = track[track.length - 1].t
  for (const other of tracks) {
    if (other === track) continue
    for (const o of other) {
      if (now - o.t > ms) continue
      const mine = track.find((f) => f.t === o.t)
      if (mine && dist(mine.palm, o.palm, aspect) <= near * Math.max(mine.scale, o.scale)) return true
    }
  }
  return false
}
