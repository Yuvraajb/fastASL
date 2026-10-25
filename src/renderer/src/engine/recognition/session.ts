import type { Dictionary } from '@shared/dictionary'
import type { Mode, SignTemplate } from '@shared/types'
import type { FrameSample, SensitivityProfile } from '../types'
import { LexiconMatcher } from './lexicon'
import { NumberMatcher } from './numbers'
import { Recognizer, type Classification, type RecognizerOptions } from './recognizer'
import { Segmenter, type SegmenterThresholds } from './segmenter'

export type RecognitionEvent =
  | { type: 'signStart' }
  | { type: 'token'; text: string; kind: 'word' | 'letter' }
  | { type: 'ambiguous'; options: string[]; kind: 'word' | 'letter' }
  | { type: 'rejected' }

export interface SessionOptions {
  thresholds?: Partial<SegmenterThresholds>
  recognizer?: Partial<RecognizerOptions>
  /** Camera image width / height (see features.ts). */
  aspect?: number
  /**
   * The gesture engine's longest control hold in ms, before sensitivity scaling (default 1000,
   * its palmHold). Outside Spell mode a letter waits until a control gesture held with the same
   * shape would have fired, so suspend() can drop it.
   */
  controlHoldMs?: number
  /** Standard signs recognized from the sign dictionary, with no recordings. Default none. */
  dictionary?: Dictionary
}

/** The gesture engine's hold can start a little after ours (it also waits for stillness). */
const CONTROL_GRACE_MS = 250
/** How long after a standard sign fires its trailing movement is ignored (ends sooner when the hands leave). */
const SETTLE_MS = 1000
/** After a number fires, the raising movement that led to it still ends here with no outcome. */
const NUMBER_SETTLE_MS = 600

/**
 * Live recognition: camera frames in, recognition events out.
 *
 * - Every `signStart` (a hand started moving) is followed by exactly one `token`, `ambiguous`
 *   or `rejected` for that movement, unless `suspend()` (or a switch to Spell mode) drops it.
 * - Static holds (letters) produce `token` or `ambiguous` with no `signStart`; an unrecognized
 *   hold stays silent, because a resting hand is a hold too. The last shape of a recognized
 *   word is not read as a letter.
 * - Outside Spell mode a letter is held back until the hand moves on (new shape, slide, hands
 *   down, a movement) or a control gesture with that shape would have fired; suspend() in that
 *   window drops it, so a fist or thumbs-up is never also an S or A.
 * - Spell mode is letters only, with no wait: movements produce no events at all.
 */
export class RecognitionSession {
  readonly recognizer: Recognizer
  private segmenter: Segmenter
  private baseHoldMs: number
  private controlHoldMs: number
  private holdScale = 1
  private lettersOnly = false
  /** Dev diagnostics: how the last movement classified (nearest word and its distance). */
  lastWord: Classification | null = null
  private suspendedUntil = -Infinity
  private lastT = 0
  private pending: { event: RecognitionEvent; until: number } | null = null
  private readonly lexicon: LexiconMatcher
  private aspect = 1
  private readonly numbers = new NumberMatcher()
  private numbersOn = false
  /** After a standard sign fires, the rest of its movement (and the hand lowering) is not a new sign until then. */
  private settleUntil = -Infinity

  constructor(options: SessionOptions = {}) {
    this.recognizer = new Recognizer(options.recognizer)
    this.segmenter = new Segmenter(options.thresholds, options.aspect)
    this.baseHoldMs = this.segmenter.thresholds.staticHoldMs
    this.controlHoldMs = options.controlHoldMs ?? 1000
    this.lexicon = new LexiconMatcher(options.dictionary)
    if (options.aspect && options.aspect > 0) this.aspect = options.aspect
  }

  setTemplates(templates: readonly SignTemplate[]): void {
    this.recognizer.setTemplates(templates)
  }

  setSensitivity(profile: SensitivityProfile): void {
    this.recognizer.setSensitivity(profile)
    this.holdScale = profile.holdScale
    this.segmenter.setThresholds({ staticHoldMs: this.baseHoldMs * profile.holdScale })
  }

  /** Recognize ASL numbers 1-5 held as a handshape (no recordings). Off by default. */
  setNumbers(on: boolean): void {
    this.numbersOn = on
    if (!on) this.numbers.reset()
  }

  setMode(mode: Mode): void {
    this.lettersOnly = mode === 'spell'
    this.recognizer.setMode(this.lettersOnly ? 'letters' : 'both')
  }

  /** Camera image width / height; safe to call every frame (0/0 before the feed has a size is ignored). */
  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect
    this.segmenter.setAspect(aspect)
  }

  /**
   * Ignore the camera for `ms` from `now` (default: the last frame's time), e.g. when a control
   * gesture fires. A sign in progress and a letter not yet released are dropped without an
   * outcome, and a shape still held afterwards (thumbs up...) is not read as a letter until it
   * changes.
   */
  suspend(ms: number, now = this.lastT): void {
    this.suspendedUntil = Math.max(this.suspendedUntil, now + ms)
    this.pending = null
    this.segmenter.reset()
  }

  /** A standard sign's handshape is held at its start: a movement from here may be that sign. */
  get signPending(): boolean {
    return this.lexicon.armed
  }

  /** How many standard signs the matcher has loaded. */
  get lexiconSize(): number {
    return this.lexicon.size
  }

  /** Dev diagnostics from the standard-sign matcher. */
  get lexiconDebug(): string {
    return this.lexicon.debug
  }

  resume(): void {
    this.suspendedUntil = -Infinity
  }

  update(frame: FrameSample): RecognitionEvent[] {
    this.lastT = frame.t
    if (frame.t < this.suspendedUntil) return []
    if (!this.lettersOnly) {
      // Always fed, even while settling, so its steadiness window never goes stale.
      const digit = this.numbersOn ? this.numbers.update(frame, this.aspect) : null
      if (frame.t < this.settleUntil && frame.hands.length > 0) {
        this.segmenter.reset()
        return []
      }
      if (digit !== null) {
        this.segmenter.reset()
        this.pending = null
        this.settleUntil = frame.t + NUMBER_SETTLE_MS
        return [{ type: 'token', text: String(digit), kind: 'word' }]
      }
      const gloss = this.lexicon.update(frame, this.aspect)
      if (gloss) {
        this.segmenter.reset()
        this.pending = null
        this.settleUntil = frame.t + SETTLE_MS
        return [{ type: 'token', text: gloss, kind: 'word' }]
      }
    }
    const segments = this.segmenter.push(frame)
    const events: RecognitionEvent[] = []
    const movedOn = this.segmenter.armed || segments.some((s) => s.kind !== 'static')
    if (this.pending && (this.lettersOnly || movedOn || frame.t >= this.pending.until)) {
      events.push(this.pending.event)
      this.pending = null
    }
    for (const segment of segments) {
      if (segment.kind === 'static') {
        const event = outcome(this.recognizer.classifyStatic(segment.features))
        if (!event) continue
        if (this.lettersOnly) events.push(event)
        else this.pending = { event, until: segment.t + this.letterDelay() }
        continue
      }
      if (this.lettersOnly) continue
      if (segment.kind === 'start') events.push({ type: 'signStart' })
      else if (segment.kind === 'cancel') events.push({ type: 'rejected' })
      else {
        const result = this.recognizer.classifyDynamic(segment.features)
        this.lastWord = result
        // The hand usually rests in a word's last shape; that is not a letter.
        if (result.status !== 'rejected') this.segmenter.blockStatic()
        events.push(outcome(result) ?? { type: 'rejected' })
      }
    }
    return events
  }

  private letterDelay(): number {
    return Math.max(0, this.controlHoldMs - this.baseHoldMs) * this.holdScale + CONTROL_GRACE_MS
  }
}

function outcome(c: Classification): RecognitionEvent | null {
  if (c.status === 'accepted' && c.label && c.kind) return { type: 'token', text: c.label, kind: c.kind }
  if (c.status === 'ambiguous' && c.kind) return { type: 'ambiguous', options: c.alternatives, kind: c.kind }
  return null
}
