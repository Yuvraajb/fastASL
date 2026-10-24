import type { SignTemplate } from '@shared/types'
import type { FrameSample } from '../types'
import { dtw, euclidean, resample } from './dtw'
import { RECOGNIZER_DEFAULTS } from './recognizer'
import { Segmenter, type Segment, type SegmenterThresholds } from './segmenter'

export interface TeachProgress {
  done: number
  total: number
  /** Whether the latest repetition was kept (null before the first one). */
  lastAccepted: boolean | null
  /** Why the latest repetition was not kept, worded for the card. */
  reason?: string
}

export type TeachEvent = { type: 'listening' } | { type: 'progress'; progress: TeachProgress }

export interface TeachOptions {
  thresholds?: Partial<SegmenterThresholds>
  /** Camera image width / height (see features.ts). */
  aspect?: number
  /**
   * Repetitions within this distance agree. Defaults to the recognizer's accept threshold:
   * one it would not match to the others does not belong with them.
   */
  outlierDistance?: number
}

export const TEACH_REASONS = {
  tooShort: 'Too short. Sign the whole word, then hold still.',
  tooLong: 'Too long. Sign it once, then hold still.',
  outlier: "That one didn't match the others. Try again."
} as const

/** Stored frames: 3 decimals, far below tracking noise. */
function roundFrames(frames: number[][]): number[][] {
  return frames.map((f) => f.map((v) => Math.round(v * 1000) / 1000))
}

/**
 * A word template from one movement's frame vectors (a dynamic segment's `features`), made the
 * way finish() makes each kept repetition: resampled to 32 frames, rounded to 3 decimals. Guess,
 * confirm, learn saves the one repetition the user confirmed this way.
 */
export function wordTemplate(label: string, features: readonly number[][], now = Date.now()): SignTemplate {
  return { id: `${label}-${now}-0`, label, kind: 'word', frames: roundFrames(resample(features)), createdAt: now }
}

interface Candidate {
  rep: number[][]
  /** Started with the hands already in view and ended holding still: not a raise or lowering. */
  clean: boolean
  /** Distance to each earlier candidate. */
  distances: number[]
}

/**
 * Word repetitions within this DTW distance agree. On a real MacBook camera one signer's clean
 * HELLO repetitions linked at 1.57-1.81, while ones that included raising the hand into view
 * sat 2.15+ away; the recognizer then widens each word's radius to fit (recognizer.ts).
 */
const WORD_AGREEMENT = 2.0

/** Older candidates outside the kept set are forgotten beyond total x this. */
const CANDIDATES_PER_REP = 3

/**
 * Records a new sign: words from dynamic segments (10 repetitions), letters from static
 * holds (5). Feed it camera frames with update(), or segments with addSegment() when a
 * Segmenter is shared. Rounds stored frames to 3 decimals (far below tracking noise).
 *
 * The kept repetitions are the largest group that agree with one another, not the first
 * ones seen: a fumbled first attempt is outvoted, and raising or lowering the hands between
 * repetitions (flagged by the segmenter) only counts when nothing cleaner was recorded.
 */
export class TeachSession {
  readonly total: number
  private candidates: Candidate[] = []
  private kept: number[] = []
  private latest: Pick<TeachProgress, 'lastAccepted' | 'reason'> = { lastAccepted: null }
  private segmenter: Segmenter
  private outlierDistance: number
  /** Links that involve a raise or lowering of the hands must be this close (see link()). */
  private strictDistance: number

  constructor(
    readonly label: string,
    readonly kind: 'word' | 'letter',
    total?: number,
    options: TeachOptions = {}
  ) {
    this.total = total ?? 5
    this.segmenter = new Segmenter(options.thresholds, options.aspect)
    this.outlierDistance =
      options.outlierDistance ?? (kind === 'word' ? WORD_AGREEMENT : RECOGNIZER_DEFAULTS.letterThreshold)
    this.strictDistance = Math.min(
      this.outlierDistance,
      kind === 'word' ? RECOGNIZER_DEFAULTS.wordThreshold : RECOGNIZER_DEFAULTS.letterThreshold
    )
  }

  get progress(): TeachProgress {
    return { done: Math.min(this.kept.length, this.total), total: this.total, ...this.latest }
  }

  get complete(): boolean {
    return this.kept.length >= this.total
  }

  /** Dev diagnostics: the latest repetition's distance to each earlier one still remembered. */
  get latestDistances(): number[] {
    return this.candidates[this.candidates.length - 1]?.distances ?? []
  }

  /** Dev diagnostics: repetitions within this distance agree. */
  get matchDistance(): number {
    return this.outlierDistance
  }

  /** Camera image width / height; invalid values are ignored. */
  setAspect(aspect: number): void {
    this.segmenter.setAspect(aspect)
  }

  update(frame: FrameSample): TeachEvent[] {
    return this.segmenter.push(frame).flatMap((segment) => this.addSegment(segment) ?? [])
  }

  addSegment(segment: Segment): TeachEvent | null {
    if (this.complete) return null
    if (this.kind === 'letter') return segment.kind === 'static' ? this.consider([segment.features], true) : null
    switch (segment.kind) {
      case 'start':
        return { type: 'listening' }
      case 'cancel':
        // A short movement is the hand getting back into position between repetitions, not a
        // failed attempt: just end "Listening". Only an overlong one gets a reason.
        if (segment.reason === 'too-short') return this.event()
        return this.result(false, TEACH_REASONS.tooLong)
      case 'dynamic':
        return this.consider(resample(segment.features), !segment.entered && !segment.left)
      default:
        return null
    }
  }

  /** One template per kept repetition (at most `total`). */
  finish(now = Date.now()): SignTemplate[] {
    return this.kept.slice(0, this.total).map((index, i) => ({
      id: `${this.label}-${now}-${i}`,
      label: this.label,
      kind: this.kind,
      frames: roundFrames(this.candidates[index].rep),
      createdAt: now
    }))
  }

  private consider(rep: number[][], clean: boolean): TeachEvent {
    this.candidates.push({ rep, clean, distances: this.candidates.map((c) => this.distance(rep, c.rep)) })
    const latest = this.candidates.length - 1
    this.kept = this.bestGroup()
    // A repetition that agrees with no earlier clean one only "wins" as the newest of several
    // lone attempts: progress doesn't move, so say why instead of nothing. (Alone among raises
    // and lowerings of the hands, it is simply the first real repetition.)
    const alone = this.kept.length === 1 && this.candidates.some((c, i) => i !== latest && c.clean)
    const accepted = this.kept.includes(latest) && !alone
    this.forgetOld()
    if (accepted) return this.result(true)
    // Probably the hands coming up or going down between repetitions: say nothing.
    if (!clean) return this.event()
    return this.result(false, TEACH_REASONS.outlier)
  }

  /**
   * Candidates are linked when within outlierDistance (the recognizer would match one to the
   * other). The kept set is the best connected group: most clean members, then most members,
   * then the newest attempt (the user's latest try is the best guess of what they mean).
   */
  private bestGroup(): number[] {
    const rank = (group: number[]): number[] => [
      group.filter((i) => this.candidates[i].clean).length,
      group.length,
      group[group.length - 1]
    ]
    let best: number[] = []
    let bestRank = [-1]
    for (const group of this.groups()) {
      const r = rank(group)
      const k = r.findIndex((v, i) => v !== bestRank[i])
      if (k >= 0 && r[k] > bestRank[k]) [best, bestRank] = [group, r]
    }
    return best
  }

  /** Connected groups of candidates, each in ascending order. */
  private groups(): number[][] {
    const grouped = new Set<number>()
    const groups: number[][] = []
    this.candidates.forEach((_, first) => {
      if (grouped.has(first)) return
      const group = [first]
      grouped.add(first)
      for (let k = 0; k < group.length; k++) {
        this.candidates.forEach((_, j) => {
          if (grouped.has(j) || !this.linked(group[k], j)) return
          grouped.add(j)
          group.push(j)
        })
      }
      groups.push(group.sort((a, b) => a - b))
    })
    return groups
  }

  private forgetOld(): void {
    if (this.candidates.length <= this.total * CANDIDATES_PER_REP) return
    const drop = this.candidates.findIndex((_, i) => !this.kept.includes(i))
    if (drop < 0) return
    this.candidates.splice(drop, 1)
    for (const c of this.candidates.slice(drop)) c.distances.splice(drop, 1)
    this.kept = this.kept.map((i) => (i > drop ? i - 1 : i))
  }

  /**
   * Two clean repetitions agree within outlierDistance. One that also caught the hands rising
   * or falling must be closer (strictDistance): otherwise the raise itself joins the kept set
   * and raising the hands would later read as the sign.
   */
  private linked(i: number, j: number): boolean {
    const both = this.candidates[i].clean && this.candidates[j].clean
    return this.between(i, j) <= (both ? this.outlierDistance : this.strictDistance)
  }

  private between(i: number, j: number): number {
    if (i === j) return 0
    return i > j ? this.candidates[i].distances[j] : this.candidates[j].distances[i]
  }

  private distance(a: number[][], b: number[][]): number {
    return this.kind === 'word' ? dtw(a, b, { band: RECOGNIZER_DEFAULTS.band }) : euclidean(a[0], b[0])
  }

  private result(accepted: boolean, reason?: string): TeachEvent {
    this.latest = reason ? { lastAccepted: accepted, reason } : { lastAccepted: accepted }
    return this.event()
  }

  private event(): TeachEvent {
    return { type: 'progress', progress: this.progress }
  }
}
