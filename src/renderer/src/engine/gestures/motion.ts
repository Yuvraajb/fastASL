/**
 * Wrist motion per hand: track continuity across frames, stillness and swipe strokes.
 * Positions are isotropic (x scaled by the source aspect), so distances in x and y compare fairly.
 */

export interface MotionSample {
  t: number
  /** Wrist position; x = normalized x × aspect, y = normalized y. */
  x: number
  y: number
  /** Palm length at this frame (same units). */
  palm: number
  /** Hand shape allowed to swipe (handShape.isFlatHand). */
  flat: boolean
}

export interface Track {
  samples: MotionSample[]
  /** When this hand was first seen at rest (null until then). Swipes only use motion after it. */
  settledAt: number | null
}

export type SwipeGesture = 'swipeLeft' | 'swipeRight' | 'swipeUp'

/** Base swipe thresholds (medium sensitivity; distance and speed are multiplied by swipeScale). */
export const SWIPE = {
  windowMs: 300,
  /** Minimum time spanned by the samples in the window. */
  minSpanMs: 100,
  /** Horizontal travel in frame widths. */
  dx: 0.22,
  /** Upward travel in frame heights. */
  dy: 0.2,
  /** Peak speed along the stroke, frame widths (or heights) per second. */
  speed: 1.2,
  /**
   * Speeds are measured between samples at least this far apart. Frame to frame, a repeated
   * image (an MJPEG canvas tracked twice per stream frame) or a frame delivered late reads as
   * zero and then double speed; a span of two 30 fps frames averages that out.
   */
  speedSpanMs: 60,
  /** Main-axis travel must exceed the cross-axis travel by this factor. */
  axisRatio: 2.2
} as const

/** Wrist speed below this (palm lengths per second) counts as holding still. */
export const STILL_SPEED = 0.8
const STILL_WINDOW_MS = 200
/** Shortest span that yields a speed; shorter (a hand that just appeared) reads as still. */
const STILL_MIN_SPAN_MS = 60
const HISTORY_MS = 500
/** A hand missing for longer than this starts a fresh track when it returns. */
const TRACK_TTL_MS = 250
/** Wrists further apart than this many palm lengths between frames are different hands. */
const MAX_MATCH_PALMS = 3
/** A track settles once it has spanned this long and its wrist is at rest. */
const SETTLE_MS = 100

const last = (track: Track): MotionSample => track.samples[track.samples.length - 1]

/**
 * Follows hands across frames by nearest wrist; handedness labels can flicker, positions don't.
 * Pairs are assigned globally, closest first, so the order MediaPipe lists hands in never lets
 * a newly appeared hand take over an existing hand's track (which would read as a jump).
 */
export class HandTracks {
  private tracks: Track[] = []

  /** Append one frame's samples (all with the same t); returns each sample's track, in order. */
  update(samples: MotionSample[], now: number): Track[] {
    this.tracks = this.tracks.filter((track) => now - last(track).t <= TRACK_TTL_MS)
    const pairs: { d: number; i: number; track: Track }[] = []
    samples.forEach((sample, i) => {
      for (const track of this.tracks) {
        const prev = last(track)
        const d = Math.hypot(prev.x - sample.x, prev.y - sample.y)
        if (d < MAX_MATCH_PALMS * sample.palm) pairs.push({ d, i, track })
      }
    })
    pairs.sort((a, b) => a.d - b.d)
    const matched: (Track | undefined)[] = []
    const taken = new Set<Track>()
    for (const { i, track } of pairs) {
      if (matched[i] || taken.has(track)) continue
      matched[i] = track
      taken.add(track)
    }

    return samples.map((sample, i) => {
      let track = matched[i]
      if (!track) {
        track = { samples: [], settledAt: null }
        this.tracks.push(track)
      }
      track.samples.push(sample)
      while (track.samples[0].t < now - HISTORY_MS) track.samples.shift()
      if (track.settledAt === null && now - track.samples[0].t >= SETTLE_MS && wristSpeed(track) <= STILL_SPEED) {
        track.settledAt = now
      }
      return track
    })
  }
}

/** Wrist speed over the last ~200 ms in palm lengths per second. */
export function wristSpeed(track: Track): number {
  const end = last(track)
  const start = track.samples.find((s) => s.t >= end.t - STILL_WINDOW_MS) ?? end
  const span = end.t - start.t
  if (span < STILL_MIN_SPAN_MS) return 0
  return Math.hypot(end.x - start.x, end.y - start.y) / end.palm / (span / 1000)
}

/**
 * A swipe stroke ending at the newest sample, using samples at or after `from`. Only motion
 * after the track settled counts, so a hand moving into view is never a stroke.
 * Mirroring: the preview is mirrored, so motion toward the left of what the user sees
 * (their own left) is +x in raw camera coordinates and reported as swipeLeft.
 */
export function detectSwipe(track: Track, from: number, scale: number, aspect: number): SwipeGesture | null {
  if (track.settledAt === null) return null
  const start = Math.max(from, track.settledAt)
  const win = track.samples.filter((s) => s.t >= start)
  if (win.length < 3) return null
  const a = win[0]
  const b = win[win.length - 1]
  if (b.t - a.t < SWIPE.minSpanMs) return null
  if (win.filter((s) => s.flat).length * 2 < win.length) return null

  const dx = b.x - a.x
  const dy = b.y - a.y
  let peakX = 0
  let peakUp = 0
  for (let i = 1, j = 0; i < win.length; i++) {
    // j: the latest sample at least speedSpanMs before sample i.
    while (win[i].t - win[j + 1].t >= SWIPE.speedSpanMs) j++
    const span = win[i].t - win[j].t
    if (span < SWIPE.speedSpanMs) continue
    const dt = span / 1000
    peakX = Math.max(peakX, (Math.sign(dx) * (win[i].x - win[j].x)) / aspect / dt)
    peakUp = Math.max(peakUp, (win[j].y - win[i].y) / dt)
  }

  const horizontal = Math.abs(dx) > SWIPE.axisRatio * Math.abs(dy)
  if (horizontal && Math.abs(dx) / aspect >= SWIPE.dx * scale && peakX >= SWIPE.speed * scale) {
    return dx > 0 ? 'swipeLeft' : 'swipeRight'
  }
  const upward = -dy > SWIPE.axisRatio * Math.abs(dx)
  if (upward && -dy >= SWIPE.dy * scale && peakUp >= SWIPE.speed * scale) return 'swipeUp'
  return null
}
