import type { Dictionary } from '@shared/dictionary'
import type { Mode, SignTemplate } from '@shared/types'
import type { FrameSample, SensitivityProfile } from '../types'
import { NumberMatcher, type NumberGate } from './numbers'
import { Recognizer, type Classification, type RecognizerOptions } from './recognizer'
import { Segmenter, type Segment, type SegmenterThresholds } from './segmenter'
import type { StreamRule } from './streamRules/types'
import { StreamingSignMatcher } from './streaming'

/** A movement the segmenter cut out (see Segment): its frames, frame vectors, duration and edges. */
export type Movement = Extract<Segment, { kind: 'dynamic' }>

export type RecognitionEvent =
  | { type: 'signStart' }
  /** `streamed`: a streaming sign or a number, recognized while the hands were still moving (no movement outcome). */
  | { type: 'token'; text: string; kind: 'word' | 'letter'; streamed?: true }
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
  /** Streaming word rules (streamRules/index.ts), run after the dictionary signs. Default none. */
  streamRules?: readonly StreamRule[]
}

/** The gesture engine's hold can start a little after ours (it also waits for stillness). */
const CONTROL_GRACE_MS = 250
/**
 * After a streaming sign fires, a movement that starts within this long is part of it (the rest
 * of the sign), and so is the movement it fired in: none of them gets a movement outcome, so
 * neither the sign model, the taught signs nor a guess can make a second word of it. Short, so a
 * next sign that only the model knows still gets its own movement. The streaming signs
 * themselves are never held back by it: a phrase of them streams word by word.
 */
export const SETTLE_MS = 500
/** The same after a number: the raising movement that led to it ends with no outcome. */
export const NUMBER_SETTLE_MS = 600

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
 * - Streaming signs come first (StreamingSignMatcher: the dictionary, then the stream rules),
 *   on every frame outside Spell mode: a `token` with `streamed`, mid-movement, with no outcome
 *   for that movement and none for a movement starting within SETTLE_MS (it is claimed). Its
 *   `signStart`, if already sent, is answered by the token itself. Numbers 1-5 (setNumbers) work
 *   the same way.
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
  /**
   * The movement behind this update's word outcome (token, ambiguous or rejected), whatever it
   * was: the pretrained sign model looks at it too. Null after every other update.
   */
  lastMovement: Movement | null = null
  private suspendedUntil = -Infinity
  private lastT = 0
  private pending: { event: RecognitionEvent; until: number } | null = null
  private readonly stream: StreamingSignMatcher
  private aspect = 1
  private readonly numbers = new NumberMatcher()
  private numbersOn = false
  private numberGate: NumberGate | undefined
  /** False while a control gesture's hold is timing toward firing: no streaming sign then. */
  private streamGate: () => boolean = () => true
  /** A movement starting before this belongs to the last streaming sign (SETTLE_MS). */
  private claimUntil = -Infinity
  /** The movement in progress belongs to a streaming sign: its end gives no outcome. */
  private claimed = false

  constructor(options: SessionOptions = {}) {
    this.recognizer = new Recognizer(options.recognizer)
    this.segmenter = new Segmenter(options.thresholds, options.aspect)
    this.baseHoldMs = this.segmenter.thresholds.staticHoldMs
    this.controlHoldMs = options.controlHoldMs ?? 1000
    this.stream = new StreamingSignMatcher({ dictionary: options.dictionary, rules: options.streamRules })
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

  setMode(mode: Mode): void {
    const lettersOnly = mode === 'spell'
    if (lettersOnly !== this.lettersOnly) this.unclaim()
    this.lettersOnly = lettersOnly
    this.recognizer.setMode(this.lettersOnly ? 'letters' : 'both')
  }

  /**
   * Recognize ASL numbers 1-5 held as a handshape (no recordings). Off by default. `allow` can
   * refuse a hand, e.g. one showing a control gesture of the current view.
   */
  setNumbers(on: boolean, allow?: NumberGate): void {
    if (on !== this.numbersOn) this.numbers.reset()
    this.numbersOn = on
    this.numberGate = allow
  }

  /**
   * Streaming signs (and numbers) fire only while `allowed()`: the app passes "no control
   * gesture hold in progress", so an open palm held at the chin (the control) is not MOM.
   */
  setStreamGate(allowed: () => boolean): void {
    this.streamGate = allowed
  }

  /** Camera image width / height; safe to call every frame (0/0 before the feed has a size is ignored). */
  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect
    this.segmenter.setAspect(aspect)
  }

  /** A streaming sign's start is in view (its handshape held where it begins): a movement now may be that sign. */
  get signPending(): boolean {
    return this.stream.armed
  }

  /** How many streaming signs are loaded (dictionary signs plus stream rules). */
  get lexiconSize(): number {
    return this.stream.size
  }

  /** Dev diagnostics from the streaming sign matcher. */
  get lexiconDebug(): string {
    return this.stream.debug
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
    // The movement into a control gesture is no streaming sign either.
    this.stream.reset()
    this.numbers.reset()
    this.unclaim()
  }

  /** The segmenter dropped its movement: nothing is claimed any more. */
  private unclaim(): void {
    this.claimed = false
    this.claimUntil = -Infinity
  }

  resume(): void {
    this.suspendedUntil = -Infinity
  }

  /**
   * A word was recognized for the last movement after the fact (the sign model answers a frame
   * or two later): the hand resting in its last shape is no letter, and a letter held since the
   * movement ended is dropped.
   */
  wordShown(): void {
    this.segmenter.blockStatic()
    this.pending = null
  }

  update(frame: FrameSample): RecognitionEvent[] {
    this.lastT = frame.t
    this.rejectedMovement = null
    this.lastMovement = null
    if (frame.t < this.suspendedUntil) return []
    const events: RecognitionEvent[] = []
    if (!this.lettersOnly) {
      // Both are fed every frame, so their own motion and steadiness windows never go stale.
      const mayFire = this.streamGate()
      const word = this.stream.update(frame, this.aspect, mayFire)
      const held = this.numbersOn ? this.numbers.update(frame, this.aspect, this.numberGate) : null
      const digit = mayFire ? held : null
      const text = word ?? (digit !== null ? String(digit) : null)
      if (text !== null) {
        this.claimUntil = frame.t + (word !== null ? SETTLE_MS : NUMBER_SETTLE_MS)
        if (this.segmenter.moving) this.claimed = true
        // A letter held back is dropped, and the hand resting in the sign's last shape is no letter.
        this.pending = null
        this.segmenter.blockStatic()
        events.push({ type: 'token', text, kind: 'word', streamed: true })
      }
    }
    const segments = this.segmenter.push(frame)
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
      if (segment.kind === 'start') {
        // Settle: the rest of a streaming sign is not a new sign.
        if (segment.t < this.claimUntil) this.claimed = true
        else events.push({ type: 'signStart' })
        continue
      }
      if (this.claimed) {
        // The movement a streaming sign was made in: no outcome, no model, no guess.
        this.claimed = false
        continue
      }
      if (segment.kind === 'cancel') events.push({ type: 'rejected' })
      else {
        const result = this.recognizer.classifyDynamic(segment.features)
        this.lastWord = result
        // The hand usually rests in a word's last shape; that is not a letter.
        if (result.status !== 'rejected') this.segmenter.blockStatic()
        const event = outcome(result)
        this.lastMovement = segment
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
