import type { SignTemplate } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { dtw, resample } from './dtw'
import { RECOGNIZER_DEFAULTS, Recognizer, type Classification } from './recognizer'
import { Segmenter, type Segment } from './segmenter'
import {
  LETTER_SHAPES,
  performHolds,
  performSign,
  rng,
  UNKNOWN,
  WORDS,
  type PerformOptions,
  type ShapeName,
  type SignSpec
} from './synthetic'

/*
 * Threshold calibration on the synthetic vocabulary. Run with CALIBRATE=1 to print the
 * distance distributions and a threshold sweep; the assertions guard the shipped defaults.
 */

const ASPECT = 4 / 3
/** A small hand (far from the camera) with ~2.6 px of jitter at 640 px. */
const FAR: Partial<PerformOptions> = { handSize: 0.1, noise: 0.004 }

function segments(frames: ReturnType<typeof performSign>): Segment[] {
  const seg = new Segmenter({}, ASPECT)
  return frames.flatMap((f) => seg.push(f))
}

function wordFeatures(spec: SignSpec, seed: number, extra: Partial<PerformOptions> = {}): number[][] | null {
  const dynamic = segments(performSign(spec, { random: rng(seed), aspect: ASPECT, ...extra })).filter((s) => s.kind === 'dynamic')
  return dynamic.length === 1 && dynamic[0].kind === 'dynamic' ? dynamic[0].features : null
}

function letterFeatures(shape: ShapeName, seed: number, extra: Partial<PerformOptions> = {}): number[] | null {
  const statics = segments(performHolds([{ shape, holdMs: 900 }], { random: rng(seed), aspect: ASPECT, ...extra })).filter(
    (s) => s.kind === 'static'
  )
  return statics.length === 1 && statics[0].kind === 'static' ? statics[0].features : null
}

const template = (label: string, kind: 'word' | 'letter', frames: number[][], i: number): SignTemplate => ({
  id: `${label}-${i}`,
  label,
  kind,
  frames,
  createdAt: 0
})

function buildTemplates(): SignTemplate[] {
  const out: SignTemplate[] = []
  for (const [label, spec] of Object.entries(WORDS)) {
    for (let i = 0; i < 10; i++) {
      const f = wordFeatures(spec, 1000 + i * 31 + label.length * 7)
      if (f) out.push(template(label, 'word', f, i))
    }
  }
  for (const label of LETTER_SHAPES) {
    for (let i = 0; i < 5; i++) {
      const v = letterFeatures(label, 7000 + i * 13 + label.charCodeAt(0))
      if (v) out.push(template(label, 'letter', [v], i))
    }
  }
  return out
}

interface Probe {
  truth: string | null
  /** Word probes only: the segment's frame vectors. */
  features?: number[][]
  run: (r: Recognizer) => Classification
}

interface Probes {
  words: Probe[]
  unknownWords: Probe[]
  letters: Probe[]
  unknownShapes: Probe[]
  /** Probes attempted per set (some may fail to segment). */
  attempts: number
}

function buildProbes(perLabel: number, extra: Partial<PerformOptions> = {}): Probes {
  const words: Probe[] = []
  const unknownWords: Probe[] = []
  const letters: Probe[] = []
  const unknownShapes: Probe[] = []
  for (const [label, spec] of Object.entries(WORDS)) {
    for (let i = 0; i < perLabel; i++) {
      const f = wordFeatures(spec, 50_000 + i * 17 + label.length * 13, extra)
      if (f) words.push({ truth: label, features: f, run: (r) => r.classifyDynamic(f) })
    }
  }
  for (const spec of Object.values(UNKNOWN)) {
    for (let i = 0; i < perLabel; i++) {
      const f = wordFeatures(spec, 90_000 + i * 11, extra)
      if (f) unknownWords.push({ truth: null, run: (r) => r.classifyDynamic(f) })
    }
  }
  for (const label of LETTER_SHAPES) {
    for (let i = 0; i < perLabel; i++) {
      const v = letterFeatures(label, 30_000 + i * 7 + label.charCodeAt(0), extra)
      if (v) letters.push({ truth: label, run: (r) => r.classifyStatic(v) })
    }
  }
  for (const shape of ['FIVE', 'CLAW'] as const) {
    for (let i = 0; i < perLabel; i++) {
      const v = letterFeatures(shape, 99_000 + i, extra)
      if (v) unknownShapes.push({ truth: null, run: (r) => r.classifyStatic(v) })
    }
  }
  return { words, unknownWords, letters, unknownShapes, attempts: perLabel }
}

interface Rates {
  correct: number
  ambiguous: number
  wrong: number
  rejected: number
}

function rates(probes: Probe[], recognizer: Recognizer): Rates {
  const n = { correct: 0, ambiguous: 0, wrong: 0, rejected: 0 }
  for (const p of probes) {
    const c = p.run(recognizer)
    if (c.status === 'rejected') n.rejected++
    else if (c.status === 'ambiguous') n.ambiguous++
    else if (c.label === p.truth) n.correct++
    else n.wrong++
  }
  const k = 1 / probes.length
  return { correct: n.correct * k, ambiguous: n.ambiguous * k, wrong: n.wrong * k, rejected: n.rejected * k }
}

const fmt = (r: Rates): string =>
  `ok ${(r.correct * 100).toFixed(1)}% amb ${(r.ambiguous * 100).toFixed(1)}% wrong ${(r.wrong * 100).toFixed(1)}% rej ${(r.rejected * 100).toFixed(1)}%`

describe('threshold calibration (synthetic signer)', () => {
  const templates = buildTemplates()
  const probes = buildProbes(20)
  const recognizer = new Recognizer()
  recognizer.setTemplates(templates)

  if (process.env.CALIBRATE) {
    it('prints a sweep', () => {
      const pct = (xs: number[], p: number): string =>
        [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(2)
      const dist = (ps: Probe[]): string =>
        [0, 0.05, 0.5, 0.95, 0.99, 1].map((p) => pct(ps.map((x) => x.run(recognizer).distance), p)).join(' ')
      console.log(`word dist p0/5/50/95/99/100   known ${dist(probes.words)} | unknown ${dist(probes.unknownWords)}`)
      const words = templates.filter((t) => t.kind === 'word').map((t) => ({ label: t.label, frames: resample(t.frames) }))
      const toOthers = (p: Probe): number[] =>
        words.filter((w) => w.label !== p.truth).map((w) => dtw(resample(p.features!), w.frames, { band: RECOGNIZER_DEFAULTS.band }))
      const nearestOther = Math.min(...probes.words.flatMap(toOthers))
      console.log(`word dist to the nearest other sign: ${nearestOther.toFixed(2)}`)
      console.log(`letter dist p0/5/50/95/99/100 known ${dist(probes.letters)} | unknown ${dist(probes.unknownShapes)}`)
      for (const t of [1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0]) {
        const r = new Recognizer({ wordThreshold: t })
        r.setTemplates(templates)
        console.log(`word ${t}: known ${fmt(rates(probes.words, r))} | unknown ${fmt(rates(probes.unknownWords, r))}`)
      }
      for (const t of [0.6, 0.7, 0.75, 0.8, 0.9, 1.0]) {
        const r = new Recognizer({ letterThreshold: t })
        r.setTemplates(templates)
        console.log(`letter ${t}: known ${fmt(rates(probes.letters, r))} | unknown ${fmt(rates(probes.unknownShapes, r))}`)
      }
    }, 60_000)
  }

  it('segments every synthetic repetition into exactly one sign / hold', () => {
    expect(templates.filter((t) => t.kind === 'word')).toHaveLength(Object.keys(WORDS).length * 10)
    expect(templates.filter((t) => t.kind === 'letter')).toHaveLength(LETTER_SHAPES.length * 5)
    expect(probes.words.length).toBeGreaterThanOrEqual(Object.keys(WORDS).length * 19)
  })

  it('recognizes known words and rejects unknown movements at the default threshold', () => {
    const known = rates(probes.words, recognizer)
    expect(known.correct).toBeGreaterThanOrEqual(0.95)
    expect(known.wrong).toBe(0)
    expect(rates(probes.unknownWords, recognizer).rejected).toBeGreaterThanOrEqual(0.95)
  })

  it('recognizes known letters with few wrong accepts at the default threshold', () => {
    const known = rates(probes.letters, recognizer)
    expect(known.correct).toBeGreaterThanOrEqual(0.95)
    expect(known.wrong).toBeLessThanOrEqual(0.02)
    // FIVE and CLAW are deliberately close to B and C; most must still be rejected.
    expect(rates(probes.unknownShapes, recognizer).rejected).toBeGreaterThanOrEqual(0.75)
  })

  it('keeps every sensitivity level inside the known/unknown gap for words', () => {
    for (const acceptScale of [0.85, 1.2]) {
      const r = new Recognizer()
      r.setTemplates(templates)
      r.setSensitivity({ holdScale: 1, swipeScale: 1, acceptScale })
      expect(rates(probes.words, r).correct).toBeGreaterThanOrEqual(0.9)
      expect(rates(probes.unknownWords, r).rejected).toBeGreaterThanOrEqual(0.9)
    }
    expect(RECOGNIZER_DEFAULTS.ambiguityRatio).toBe(0.85)
  })

  it('still segments and recognizes small hands with noisy tracking', () => {
    const far = buildProbes(5, FAR)
    expect(far.words.length).toBeGreaterThanOrEqual(Object.keys(WORDS).length * far.attempts * 0.95)
    expect(far.letters.length).toBeGreaterThanOrEqual(LETTER_SHAPES.length * far.attempts * 0.95)
    expect(rates(far.words, recognizer).correct).toBeGreaterThanOrEqual(0.95)
    expect(rates(far.unknownWords, recognizer).rejected).toBeGreaterThanOrEqual(0.95)
    expect(rates(far.letters, recognizer).correct).toBeGreaterThanOrEqual(0.95)
  })
})
