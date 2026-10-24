import type { SignTemplate } from '@shared/types'
import { SENSITIVITY, type SensitivityProfile } from '../types'
import { dtw, resample } from './dtw'
import { FRAME_FEATURE_DIM, STATIC_FEATURE_DIM } from './features'
import { knn, type LabeledVector, type Neighbor } from './knn'

export type RecognizerMode = 'words' | 'letters' | 'both'

export interface Classification {
  status: 'accepted' | 'ambiguous' | 'rejected'
  /** Best guess (absent when rejected). */
  label?: string
  kind?: 'word' | 'letter'
  /** Distance of the best match (DTW mean frame distance or static-vector distance). */
  distance: number
  /** Up to 3 distinct labels, best first: the options of a "Did you mean" prompt. */
  alternatives: string[]
}

export interface RecognizerOptions {
  /**
   * Max DTW distance (mean frame distance) to accept a word, before sensitivity scaling: the
   * floor of each word's own radius (see radiusScale).
   */
  wordThreshold: number
  /**
   * Each word's accept distance follows how consistently it was recorded: radiusScale x the
   * median distance from each of its templates to the nearest other one, clamped to
   * [wordThreshold, maxWordThreshold]. A word recorded on a real, noisy camera gets a wider
   * radius than one recorded by a steady signer, without widening every other word.
   */
  radiusScale: number
  maxWordThreshold: number
  /** Max static-vector distance to accept a letter, before sensitivity scaling. */
  letterThreshold: number
  /** best / second-best distance above this (second best being another label) = ambiguous. */
  ambiguityRatio: number
  /** Sakoe-Chiba band (frames of the 32-frame resampled sequences). */
  band: number
  /** Neighbors voting on a letter. */
  k: number
}

/**
 * Calibrated by calibration.test.ts (`CALIBRATE=1` prints the sweep) on the synthetic signer in
 * synthetic.ts: 10 words (two of them two-handed) x 10 templates, 12 letters x 5, probed with
 * fresh repetitions that vary like a real signer's: +-20% tempo, +-15% amplitude, timing warp,
 * +-20% hand size, +-8 deg orientation, finger-curl jitter, ~1.6 px landmark jitter, frame-time
 * jitter and 2% dropped frames.
 *
 * Words (DTW mean frame distance): same sign p50 0.51 / p99 0.89 / max 0.93; nearest other
 * sign >= 1.75; unknown movements >= 2.10. 1.5 sits in the known/unknown gap, and so do the
 * low/high sensitivity variants (x0.85 = 1.28, x1.2 = 1.8): 100% accepted, 100% unknowns rejected.
 * Letters (static-vector distance): same letter p50 0.30 / p99 0.64; nearest other letter
 * >= 0.81; near-letter non-letters (FIVE vs B, CLAW vs C) from 0.57. 0.7 accepts 99.6% and
 * rejects ~82% of those look-alikes (the rest read as the letter they resemble).
 * Hands half the size (far from the camera) with ~2.6 px jitter: same-sign p95 1.03, still
 * >= 95% of words and letters recognized and unknowns rejected.
 * Real cameras are noisier than this model. On a MacBook camera (1280x720, ~17-30 fps) one
 * signer's clean HELLO repetitions sat 1.57-1.81 from their nearest neighbor (pairwise up to
 * ~2.3; raising the hand into view as part of it 2.2-3.4), so a fixed 1.5 rejected every real
 * repetition. Hence the per-word radius: 1.4 x that median nearest distance gives HELLO ~2.2,
 * while synthetic words (median ~0.5) keep the floor of 1.5, and the cap of 2.4 stays under
 * the raises and other movements measured there.
 */
export const RECOGNIZER_DEFAULTS: RecognizerOptions = {
  wordThreshold: 1.5,
  radiusScale: 1.4,
  maxWordThreshold: 2.4,
  letterThreshold: 0.7,
  ambiguityRatio: 0.85,
  band: 4,
  k: 3
}

const REJECTED: Classification = { status: 'rejected', distance: Infinity, alternatives: [] }

/** Nearest-neighbor sign classifier over the user's recorded templates. */
export class Recognizer {
  private options: RecognizerOptions
  private words: { label: string; frames: number[][] }[] = []
  /** Accept distance per word label (see RecognizerOptions.radiusScale). */
  private radii = new Map<string, number>()
  private letters: LabeledVector[] = []
  private profile: SensitivityProfile = SENSITIVITY.medium
  private mode: RecognizerMode = 'both'

  constructor(options: Partial<RecognizerOptions> = {}) {
    this.options = { ...RECOGNIZER_DEFAULTS, ...options }
  }

  /** Templates with the wrong vector size (an older feature layout) are skipped. */
  setTemplates(templates: readonly SignTemplate[]): void {
    this.words = []
    this.letters = []
    for (const t of templates) {
      if (t.kind === 'word') {
        if (t.frames.length >= 2 && t.frames.every((f) => f.length === FRAME_FEATURE_DIM)) {
          this.words.push({ label: t.label, frames: resample(t.frames) })
        }
      } else {
        for (const f of t.frames) if (f.length === STATIC_FEATURE_DIM) this.letters.push({ label: t.label, vector: f })
      }
    }
    this.radii = wordRadii(this.words, this.options)
  }

  /** A word's accept distance before sensitivity scaling (dev diagnostics, tests). */
  wordRadius(label: string): number {
    return this.radii.get(label) ?? this.options.wordThreshold
  }

  setSensitivity(profile: SensitivityProfile): void {
    this.profile = profile
  }

  setMode(mode: RecognizerMode): void {
    this.mode = mode
  }

  /** Classify a dynamic segment (per-frame vectors) against the word templates. */
  classifyDynamic(features: readonly number[][]): Classification {
    if (this.mode === 'letters' || this.words.length === 0 || features.length === 0) return REJECTED
    const query = resample(features)
    const nearest = new Map<string, number>()
    for (const word of this.words) {
      const d = dtw(query, word.frames, { band: this.options.band })
      if (d < (nearest.get(word.label) ?? Infinity)) nearest.set(word.label, d)
    }
    const ranked = [...nearest]
      .map(([label, distance]) => ({ label, distance }))
      .sort((a, b) => a.distance - b.distance)
    return this.decide(ranked, 'word', this.wordRadius(ranked[0].label))
  }

  /** Classify a static handshape vector against the letter templates. */
  classifyStatic(vector: readonly number[]): Classification {
    if (this.mode === 'words' || vector.length !== STATIC_FEATURE_DIM) return REJECTED
    const result = knn(vector, this.letters, this.options.k)
    return result ? this.decide(result.ranked, 'letter', this.options.letterThreshold) : REJECTED
  }

  private decide(ranked: Neighbor[], kind: 'word' | 'letter', threshold: number): Classification {
    const [best, second] = ranked
    const alternatives = ranked.slice(0, 3).map((n) => n.label)
    if (best.distance > threshold * this.profile.acceptScale) {
      return { status: 'rejected', distance: best.distance, alternatives }
    }
    const ambiguous =
      second !== undefined && (second.distance <= 0 || best.distance / second.distance > this.options.ambiguityRatio)
    return { status: ambiguous ? 'ambiguous' : 'accepted', label: best.label, kind, distance: best.distance, alternatives }
  }
}

/** Each word's accept distance from how close its templates are to one another. */
function wordRadii(words: readonly { label: string; frames: number[][] }[], o: RecognizerOptions): Map<string, number> {
  const byLabel = new Map<string, number[][][]>()
  for (const w of words) byLabel.set(w.label, [...(byLabel.get(w.label) ?? []), w.frames])
  const radii = new Map<string, number>()
  for (const [label, seqs] of byLabel) {
    const nearest = seqs
      .map((a, i) => Math.min(...seqs.map((b, j) => (i === j ? Infinity : dtw(a, b, { band: o.band })))))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
    const median = nearest.length ? nearest[Math.floor((nearest.length - 1) / 2)] : 0
    radii.set(label, Math.min(o.maxWordThreshold, Math.max(o.wordThreshold, median * o.radiusScale)))
  }
  return radii
}
