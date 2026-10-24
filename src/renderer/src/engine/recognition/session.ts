import type { Mode, SignTemplate } from '@shared/types'
import type { FrameSample, SensitivityProfile } from '../types'
import { Recognizer, type Classification, type RecognizerOptions } from './recognizer'
import { Segmenter, type Segment, type SegmenterThresholds } from './segmenter'

/** A movement the segmenter cut out (see Segment): its frames, frame vectors, duration and edges. */
export type Movement = Extract<Segment, { kind: 'dynamic' }>

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
}

/** The gesture engine's hold can start a little after ours (it also waits for stillness). */
const CONTROL_GRACE_MS = 250

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
  /**
   * The movement behind this update's 'rejected' event, when it was a whole movement that no
   * taught word matched (not a cancel): guess, confirm, learn may ask an LLM what it was.
   * Null after every other update.
   */
  rejectedMovement: Movement | null = null
  private suspendedUntil = -Infinity
  private lastT = 0
  private pending: { event: RecognitionEvent; until: number } | null = null

  constructor(options: SessionOptions = {}) {
    this.recognizer = new Recognizer(options.recognizer)
    this.segmenter = new Segmenter(options.thresholds, options.aspect)
    this.baseHoldMs = this.segmenter.thresholds.staticHoldMs
    this.controlHoldMs = options.controlHoldMs ?? 1000
  }

  setTemplates(templates: readonly SignTemplate[]): void {
    this.recognizer.setTemplates(templates)
  }

  setSensitivity(profile: SensitivityProfile): void {
    this.recognizer.setSensitivity(profile)
    this.holdScale = profile.holdScale
    this.segmenter.setThresholds({ staticHoldMs: this.baseHoldMs * profile.holdScale })
  }

  setMode(mode: Mode): void {
    this.lettersOnly = mode === 'spell'
    this.recognizer.setMode(this.lettersOnly ? 'letters' : 'both')
  }

  /** Camera image width / height; safe to call every frame (0/0 before the feed has a size is ignored). */
  setAspect(aspect: number): void {
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

  resume(): void {
    this.suspendedUntil = -Infinity
  }

  update(frame: FrameSample): RecognitionEvent[] {
    this.lastT = frame.t
    this.rejectedMovement = null
    if (frame.t < this.suspendedUntil) return []
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
        const event = outcome(result)
        if (!event) this.rejectedMovement = segment
        events.push(event ?? { type: 'rejected' })
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
