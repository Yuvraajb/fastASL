import type { FrameSample, HandSample } from '../types'
import { analyzeHand, DIGITS, type Digit, type DigitState } from '../gestures/handShape'
import { measureHand } from './features'

/*
 * A short text summary of one movement, measured from hand tracking, for the LLM that guesses
 * an unknown sign (guess, confirm, learn). The frames show where the hands are relative to the
 * face and body; this says what the frames can blur: the handshape at the start and the end,
 * which way each hand went and how far, and how long it took.
 *
 * Directions are the signer's own. The camera image is not mirrored, so image +x is the signer's
 * left. Distances are in hand lengths (wrist to middle knuckle), like the recognizer's features.
 * Handedness labels are unreliable (DECISIONS 40), so hands are named by the side they are on.
 */

/** A hand counts when it is tracked in this share of the movement's frames. */
const PRESENT_SHARE = 0.3
/** Frames averaged for the start and the end (handshape, position, size). */
const EDGE_FRAMES = 3
/** Below this (hand lengths) a hand stays in place. */
const STILL = 0.4
/** A direction component is named when it is at least this share of the movement. */
const COMPONENT = 0.35
/** A reversal along an axis needs this much travel (hand lengths) each way. */
const REVERSAL = 0.5
/**
 * A hand this many hand lengths from the only tracked one, this soon after it, is a second hand
 * (one hand moves under ~1 hand length between camera frames).
 */
const OTHER_HAND = 2.5
const OTHER_HAND_MS = 200
/** A path this many times the farthest excursion, spread on both axes, is a circle. */
const CIRCLE_PATH = 2.6
/** Hand size ratio end / start beyond which the hand moved toward (or away from) the camera. */
const DEPTH = 1.2

interface Point {
  t: number
  hand: HandSample
  x: number
  y: number
  scale: number
}

interface Vec {
  x: number
  y: number
}

/** The summary of one movement (a dynamic segment's frames). `aspect` is image width / height. */
export function summarizeMotion(frames: readonly FrameSample[], aspect = 1, durationMs?: number): string {
  const duration = durationMs ?? (frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0)
  const head = `${(duration / 1000).toFixed(1)} s`
  const tracks = handTracks(frames, aspect)
  if (tracks.length === 0) return `${head}, no hands tracked.`
  if (tracks.length === 1) {
    const [track] = tracks
    return `${head}, one hand, on the signer's ${sideOf(track)}, ${heightOf(track)} in the frame.\nHand: ${describeHand(track, aspect)}`
  }
  // Two hands: the one that travels more first (the dominant hand, usually).
  const [a, b] = [...tracks].sort((p, q) => pathLength(smooth(q)) - pathLength(smooth(p)))
  // Image left is the signer's right.
  const wristX = (track: Point[]): number => mean(track.map((p) => p.hand.landmarks[0].x))
  const [aSide, bSide] = wristX(a) <= wristX(b) ? ['right', 'left'] : ['left', 'right']
  const lines = [
    `${head}, two hands${handsApart(a, b)}.`,
    `Signer's ${aSide} hand (moves more): ${describeHand(a, aspect)}`,
    `Signer's ${bSide} hand: ${describeHand(b, aspect)}`
  ]
  return lines.join('\n')
}

/**
 * Each hand's tracked points. Hands are followed by position, not by MediaPipe's Left/Right
 * label, which flickers: a flicker would otherwise split one hand into two.
 */
function handTracks(frames: readonly FrameSample[], aspect: number): Point[][] {
  const tracks: Point[][] = []
  for (const frame of frames) {
    const points = [...frame.hands]
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .flatMap((hand): Point[] => {
        const m = measureHand(hand, aspect)
        return m ? [{ t: frame.t, hand, x: m.x, y: m.y, scale: m.scale }] : []
      })
    const last = tracks.map((t) => t[t.length - 1])
    const gap = (p: Point, q: Point): number => dist(p, q) / p.scale
    if (points.length === 0) continue
    if (tracks.length === 0) {
      for (const p of points) tracks.push([p])
    } else if (tracks.length === 1) {
      // The nearest point continues the hand; another one far away (or a second point) is the other hand.
      const [near, ...rest] = [...points].sort((p, q) => gap(p, last[0]) - gap(q, last[0]))
      const jumped = gap(near, last[0]) > OTHER_HAND && near.t - last[0].t < OTHER_HAND_MS
      if (jumped) tracks.push([near])
      else tracks[0].push(near)
      if (rest.length && !jumped) tracks.push([rest[0]])
    } else if (points.length === 1) {
      const [p] = points
      tracks[gap(p, last[0]) <= gap(p, last[1]) ? 0 : 1].push(p)
    } else {
      const [p, q] = points
      const keep = gap(p, last[0]) + gap(q, last[1]) <= gap(p, last[1]) + gap(q, last[0])
      tracks[0].push(keep ? p : q)
      tracks[1].push(keep ? q : p)
    }
  }
  const needed = Math.max(2, Math.ceil(frames.length * PRESENT_SHARE))
  return tracks.filter((t) => t.length >= needed)
}

function describeHand(track: Point[], aspect: number): string {
  const start = shapeName(digitStates(track.slice(0, EDGE_FRAMES), aspect))
  const end = shapeName(digitStates(track.slice(-EDGE_FRAMES), aspect))
  const shape = start === end ? `${start} throughout` : `starts ${start}, ends ${end}`
  return `${shape}. ${describeMovement(track)}`
}

/** Where the hand went: its farthest point from the start, whether it came back, repeats, depth. */
function describeMovement(track: Point[]): string {
  const unit = median(track.map((p) => p.scale))
  const path = smooth(track).map((p) => ({ x: p.x / unit, y: p.y / unit }))
  const start = meanPoint(path.slice(0, EDGE_FRAMES))
  const end = meanPoint(path.slice(-EDGE_FRAMES))
  let far = start
  let reach = 0
  for (const p of path) {
    const d = dist(p, start)
    if (d > reach) [far, reach] = [p, d]
  }
  const parts: string[] = []
  if (reach < STILL) {
    parts.push(`Stays in place (${reach.toFixed(1)} hand lengths)`)
  } else {
    const away = { x: far.x - start.x, y: far.y - start.y }
    const back = dist(end, start) < reach / 2
    const travelled = pathLength(path)
    const extentX = extent(path.map((p) => p.x))
    const extentY = extent(path.map((p) => p.y))
    const circle = travelled > CIRCLE_PATH * reach && Math.min(extentX, extentY) > 0.5 * Math.max(extentX, extentY)
    if (circle) {
      parts.push(`Moves in a circle about ${Math.max(extentX, extentY).toFixed(1)} hand lengths across`)
    } else {
      parts.push(`Moves ${direction(away)} ${reach.toFixed(1)} hand lengths${back ? ', then back' : ''}`)
      const horizontal = Math.abs(away.x) >= Math.abs(away.y)
      const strokes = reversals(path.map((p) => (horizontal ? p.x : p.y))) + 1
      if (strokes >= 3) parts.push(`repeated: ${strokes} strokes ${horizontal ? 'side to side' : 'up and down'}`)
    }
  }
  const sizeChange = mean(track.slice(-EDGE_FRAMES).map((p) => p.scale)) / mean(track.slice(0, EDGE_FRAMES).map((p) => p.scale))
  if (sizeChange >= DEPTH) parts.push('toward the camera')
  else if (sizeChange <= 1 / DEPTH) parts.push('away from the camera')
  return `${parts.join(', ')}.`
}

/** "toward the signer's right and down": image +x is the signer's left, +y is down. */
function direction(v: Vec): string {
  const size = Math.hypot(v.x, v.y)
  const horizontal = Math.abs(v.x) >= COMPONENT * size ? (v.x > 0 ? "toward the signer's left" : "toward the signer's right") : ''
  const vertical = Math.abs(v.y) >= COMPONENT * size ? (v.y > 0 ? 'down' : 'up') : ''
  // The larger component first.
  const named = Math.abs(v.x) >= Math.abs(v.y) ? [horizontal, vertical] : [vertical, horizontal]
  return named.filter(Boolean).join(' and ')
}

/** Turns along one axis, each after at least REVERSAL of travel. */
export function reversals(values: readonly number[]): number {
  if (values.length < 2) return 0
  let count = 0
  /** +1 rising, -1 falling, 0 until the first REVERSAL of travel. */
  let dir = 0
  /** The running peak (rising) or trough (falling). */
  let extreme = values[0]
  let [lo, hi] = [values[0], values[0]]
  for (const v of values) {
    if (dir === 0) {
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
      if (v - lo >= REVERSAL) [dir, extreme] = [1, v]
      else if (hi - v >= REVERSAL) [dir, extreme] = [-1, v]
    } else if (dir * (v - extreme) > 0) {
      extreme = v
    } else if (Math.abs(v - extreme) >= REVERSAL) {
      count++
      ;[dir, extreme] = [-dir, v]
    }
  }
  return count
}

/** " that come together" / " that move apart", when the distance between the hands changes clearly. */
function handsApart(a: Point[], b: Point[]): string {
  const unit = median([...a, ...b].map((p) => p.scale))
  const gap = (pa: Point[], pb: Point[]): number => dist(meanPoint(pa), meanPoint(pb)) / unit
  const before = gap(a.slice(0, EDGE_FRAMES), b.slice(0, EDGE_FRAMES))
  const after = gap(a.slice(-EDGE_FRAMES), b.slice(-EDGE_FRAMES))
  if (before - after >= 1) return ' that come together'
  if (after - before >= 1) return ' that move apart'
  return ''
}

/** The signer's side: image left is the signer's right. */
function sideOf(track: Point[]): 'right' | 'left' {
  return mean(track.map((p) => p.hand.landmarks[0].x)) < 0.5 ? 'right' : 'left'
}

function heightOf(track: Point[]): string {
  const y = mean(track.map((p) => p.hand.landmarks[9].y))
  return y < 1 / 3 ? 'high' : y > 2 / 3 ? 'low' : 'at mid height'
}

/** Each digit's state, by majority over a few frames (ties go to 'partial'). */
function digitStates(points: Point[], aspect: number): Record<Digit, DigitState> {
  const shapes = points.map((p) => analyzeHand(p.hand, aspect).state)
  const out = {} as Record<Digit, DigitState>
  for (const d of DIGITS) {
    const count = (s: DigitState): number => shapes.filter((shape) => shape[d] === s).length
    const half = shapes.length / 2
    out[d] = count('extended') > half ? 'extended' : count('folded') > half ? 'folded' : 'partial'
  }
  return out
}

/** Handshape names that tell the model what the fingers do, with the ASL handshape they resemble. */
const NAMED: Record<string, string> = {
  'thumb index middle ring pinky': 'open hand, all five fingers extended',
  'index middle ring pinky': 'flat hand, four fingers extended (B)',
  '': 'fist',
  thumb: 'fist with the thumb out (A)',
  index: 'index finger extended (1)',
  'index middle': 'index and middle extended (V or U)',
  'thumb index': 'thumb and index extended (L)',
  'thumb pinky': 'thumb and pinky extended (Y)',
  'thumb index pinky': 'thumb, index and pinky extended (I love you)',
  pinky: 'pinky extended (I)',
  'index middle ring': 'index, middle and ring extended (W)',
  'thumb index middle': 'thumb, index and middle extended (3)',
  'index pinky': 'index and pinky extended (horns)'
}

export function shapeName(state: Record<Digit, DigitState>): string {
  const extended = DIGITS.filter((d) => state[d] === 'extended')
  const bent = DIGITS.filter((d) => state[d] === 'partial')
  if (extended.length === 0 && bent.length >= 3) return 'curved hand, fingers bent (C or claw)'
  const name = NAMED[extended.join(' ')] ?? `${list(extended)} extended`
  return bent.length && extended.length ? `${name}, ${list(bent)} bent` : name
}

const list = (words: string[]): string =>
  words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`

/** 3-point moving average, so landmark jitter doesn't add up to travel or fake reversals. */
function smooth(track: Point[]): Point[] {
  return track.map((p, i) => {
    const near = track.slice(Math.max(0, i - 1), i + 2)
    return { ...p, x: mean(near.map((q) => q.x)), y: mean(near.map((q) => q.y)) }
  })
}

function pathLength(points: Vec[]): number {
  let sum = 0
  for (let i = 1; i < points.length; i++) sum += dist(points[i], points[i - 1])
  return sum
}

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)
const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length)
const meanPoint = (points: Vec[]): Vec => ({ x: mean(points.map((p) => p.x)), y: mean(points.map((p) => p.y)) })
const extent = (values: number[]): number => Math.max(...values) - Math.min(...values)

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 1
}
