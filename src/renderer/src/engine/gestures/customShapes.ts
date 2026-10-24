import type { CustomGesture, SignTemplate } from '@shared/types'
import { euclidean } from '../recognition/dtw'
import { measureHand, staticFeatures, STATIC_FEATURE_DIM } from '../recognition/features'
import { knn, type LabeledVector } from '../recognition/knn'
import { Recognizer } from '../recognition/recognizer'
import type { FrameSample, HandSample, SensitivityProfile } from '../types'
import type { ShapeMatcher } from './engine'
import { analyzeHand, FINGERS, fingerCount, isFist, isOpenPalm, isPeace, isThumbsUp, type HandShape } from './handShape'

/*
 * Custom gesture shapes: a saved handshape is a handful of static vectors (recognition's
 * staticFeatures: hand-relative, left hands mirrored), matched with kNN like a letter.
 *
 * Calibration (customShapes.test.ts, on recognition's synthetic signers): one 1 s capture
 * is matched against later holds of the same shape that vary like a real signer's (hand
 * size ±20%, tilt ±8°, finger curl ±0.06). At 0.75, 80-100% of holds with the same hand
 * match in at least 80% of their frames (about 80% with the other hand, 70% for a small,
 * jittery hand), and every other synthetic handshape stays beyond 1.0 of the captures
 * (A, L, I, Y); only near-copies (C and CLAW, 0.5-0.6 apart) come closer. Letters use
 * 0.7 with five recorded repetitions; one capture covers less variation, so it gets a
 * little more room. A relaxed hand comes within 0.67 of a C and 0.8 of a CLAW, which is
 * why loose shapes are refused: a resting hand must never run a shortcut.
 */

/** Static-vector distance (hand lengths) within which a hand matches a saved shape. */
const SHAPE_MATCH_DISTANCE = 0.75
/** How long a new shape is recorded. */
export const CAPTURE_MS = 1000
/** Samples kept per saved shape (spread over the capture). */
export const SHAPE_SAMPLES = 10
/** Neighbors voting on a match. */
const K = 3
/** A capture needs a hand in this share of its frames, and at least MIN_SAMPLES of them. */
const MIN_PRESENT = 0.6
const MIN_SAMPLES = 8
/**
 * Largest distance between the mean shapes of the capture's thirds. Still holds stay under
 * 0.15 (0.65 for a small, jittery hand); changing shape, or changing and coming back, gives 1.1+.
 */
const MAX_DRIFT = 0.7
/** A capture that reads as one control gesture (or a saved shape, or a taught letter) in this share of its frames is refused. */
const CONFLICT_SHARE = 0.3

export type ShapeCapture = { ok: true; shape: number[][] } | { ok: false; reason: string }

export const CAPTURE_REASONS = {
  noHand: 'No hand seen. Hold one hand up in view.',
  moved: 'Your hand moved. Hold the shape still.',
  loose: 'That looks like a resting hand. Make a clearer shape.',
  control: (name: string) => `That reads as ${name}, a control gesture. Try another shape.`,
  taken: (name: string) => `Too close to “${name}”. Try another shape.`,
  letter: (label: string) => `That reads as the letter ${label}. Try another shape.`
}

type Shaped = Pick<CustomGesture, 'id' | 'shape'>

/** What a new shape must not be mistaken for, besides the control gestures. */
export interface ShapeRivals {
  /** The saved gestures. */
  gestures?: readonly Pick<CustomGesture, 'id' | 'name' | 'shape'>[]
  /**
   * The user's taught signs. In Command mode a held letter waits out the control holds, so a
   * shape that reads as a taught letter would fire first and drop the letter.
   */
  templates?: readonly SignTemplate[]
  /** Recognition's sensitivity, which widens or narrows what reads as a letter. */
  sensitivity?: SensitivityProfile
}

const isVector = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length === STATIC_FEATURE_DIM && v.every(Number.isFinite)

function samplesOf(gestures: readonly Shaped[]): LabeledVector[] {
  // Hand-edited files may hold anything: only well-formed vectors take part.
  return gestures.flatMap((g) =>
    (Array.isArray(g.shape) ? g.shape : []).filter(isVector).map((vector) => ({ label: g.id, vector }))
  )
}

function match(vector: readonly number[], samples: readonly LabeledVector[]): string | null {
  const best = knn(vector, samples, K)
  return best && best.distance <= SHAPE_MATCH_DISTANCE ? best.label : null
}

/** The engine's custom matcher for the saved shapes (null when none has one). `aspect` is source width / height. */
export function shapeMatcher(gestures: readonly Shaped[], aspect = 1): ShapeMatcher | null {
  const samples = samplesOf(gestures)
  if (!samples.length) return null
  return (hand) => {
    const vector = staticFeatures(hand, aspect)
    const id = vector && match(vector, samples)
    return id ? { id } : null
  }
}

/** The control gesture a hand shape reads as, named for the card, or null. */
function controlShapeName(shape: HandShape): string | null {
  if (isThumbsUp(shape)) return 'a thumbs-up'
  if (isFist(shape)) return 'a fist'
  if (isOpenPalm(shape)) return 'an open palm'
  if (isPeace(shape)) return 'the peace sign'
  const count = fingerCount(shape)
  return count ? `${count} finger${count === 1 ? '' : 's'}` : null
}

/** The taught letter a vector reads as, with recognition's own letter classifier; null without letters. */
function letterReader(rivals: ShapeRivals): ((vector: readonly number[]) => string | null) | null {
  const letters = (rivals.templates ?? []).filter((t) => t.kind === 'letter')
  if (!letters.length) return null
  const recognizer = new Recognizer()
  recognizer.setTemplates(letters)
  recognizer.setMode('letters')
  if (rivals.sensitivity) recognizer.setSensitivity(rivals.sensitivity)
  return (vector) => {
    // A close call between two letters still reads as a letter (recognitionInput takes the best guess).
    const reading = recognizer.classifyStatic(vector)
    return reading.status === 'rejected' ? null : (reading.label ?? null)
  }
}

/** Every finger half bent: a relaxed or resting hand (or a C), which controls never read either. */
const isLoose = (shape: HandShape): boolean => FINGERS.every((f) => shape.state[f] === 'partial')

/** The most frequent non-null value, if it makes up at least `share` of `values`. */
function dominant(values: readonly (string | null)[], share: number): string | null {
  const counts = new Map<string, number>()
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: string | null = null
  for (const [v, n] of counts) if (best === null || n > counts.get(best)!) best = v
  return best !== null && counts.get(best)! >= share * values.length ? best : null
}

function mean(vectors: readonly (readonly number[])[]): number[] {
  const out = new Array<number>(vectors[0].length).fill(0)
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i] / vectors.length
  return out
}

/** Held still: the mean shapes of the first, middle and last third agree. */
function steady(vectors: readonly number[][]): boolean {
  const [a, b] = [Math.floor(vectors.length / 3), Math.floor((vectors.length * 2) / 3)]
  const [first, middle, last] = [vectors.slice(0, a), vectors.slice(a, b), vectors.slice(b)].map(mean)
  return [euclidean(first, middle), euclidean(middle, last), euclidean(first, last)].every((d) => d <= MAX_DRIFT)
}

/** `count` items spread evenly over `items`. */
function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items]
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))])
}

/** The largest hand of a frame (the one making the shape when both are up). */
function mainHand(frame: FrameSample, aspect: number): HandSample | null {
  let best: HandSample | null = null
  let size = 0
  for (const hand of frame.hands) {
    const scale = measureHand(hand, aspect)?.scale ?? 0
    if (scale > size) [best, size] = [hand, scale]
  }
  return best
}

/**
 * Judges the frames recorded for a new shape: one hand held still in a shape that is no
 * control gesture, no other saved shape and no taught letter. Returns the samples to save, or why not.
 */
export function captureShape(frames: readonly FrameSample[], aspect: number, rivals: ShapeRivals = {}): ShapeCapture {
  const hands: HandSample[] = []
  const vectors: number[][] = []
  for (const frame of frames) {
    const hand = mainHand(frame, aspect)
    const vector = hand && staticFeatures(hand, aspect)
    if (!hand || !vector) continue
    hands.push(hand)
    vectors.push(vector)
  }
  if (vectors.length < MIN_SAMPLES || vectors.length < MIN_PRESENT * frames.length) {
    return { ok: false, reason: CAPTURE_REASONS.noHand }
  }
  if (!steady(vectors)) return { ok: false, reason: CAPTURE_REASONS.moved }
  const shapes = hands.map((h) => analyzeHand(h, aspect))
  const control = dominant(shapes.map(controlShapeName), CONFLICT_SHARE)
  if (control) return { ok: false, reason: CAPTURE_REASONS.control(control) }
  if (shapes.filter(isLoose).length >= CONFLICT_SHARE * shapes.length) return { ok: false, reason: CAPTURE_REASONS.loose }
  const existing = rivals.gestures ?? []
  const samples = samplesOf(existing)
  const taken = samples.length ? dominant(vectors.map((v) => match(v, samples)), CONFLICT_SHARE) : null
  if (taken) return { ok: false, reason: CAPTURE_REASONS.taken(existing.find((g) => g.id === taken)?.name ?? 'a saved shape') }
  const readLetter = letterReader(rivals)
  const letter = readLetter && dominant(vectors.map(readLetter), CONFLICT_SHARE)
  if (letter) return { ok: false, reason: CAPTURE_REASONS.letter(letter) }
  return { ok: true, shape: spread(vectors, SHAPE_SAMPLES).map((v) => v.map((x) => Math.round(x * 1000) / 1000)) }
}
