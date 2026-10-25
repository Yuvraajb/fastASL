import type { Dictionary } from '@shared/dictionary'
import type { FaceBox, FrameSample } from '../types'
import { faceBoxOf } from './faceBox'
import { LexiconMatcher } from './lexicon'
import type { StreamContext, StreamRule } from './streamRules/types'

/** Rules see at most this much history (StreamRule.fires). */
export const STREAM_HISTORY_MS = 1500
/**
 * A face box is reused this long on frames that lack one: FaceLandmarker runs on every other
 * frame and loses the face now and then, and the head moves slowly.
 */
export const FACE_HOLD_MS = 1000
/**
 * After a word fires, that word can't fire again for this long. TIME's two taps fired "time" twice
 * at 900 ms live ("time time" -> "What time is it?"); one movement is one word.
 */
export const STREAM_COOLDOWN_MS = 1600
/** After any word fires, no other word for this long: one movement is one word. */
export const STREAM_GAP_MS = 300

/**
 * Streaming signs: every frame, the dictionary signs (LexiconMatcher: HELLO, MEETING) and then
 * each StreamRule in order get a look, and the first to fire wins. A word fires the moment its
 * movement is far enough along, not when the hands come to rest, so it shows up a fraction of a
 * second into the sign.
 *
 * After a word fires:
 *  - the rules' history starts over from the next frame, so the frames that made one word can't
 *    make another (a rule only ever sees what happened since the last word);
 *  - the same word waits STREAM_COOLDOWN_MS and any other word STREAM_GAP_MS.
 * Frames with no hands are kept in the history but never fire a rule. A rule that throws is
 * skipped for that frame, with one console warning; recognition carries on.
 */
export class StreamingSignMatcher {
  private readonly lexicon: LexiconMatcher
  private readonly rules: readonly StreamRule[]
  private readonly dictionaryWords: string[]
  private history: FrameSample[] = []
  private face: { box: FaceBox; t: number } | null = null
  private lastFireT = -Infinity
  private readonly cooldownUntil = new Map<string, number>()
  private readonly warned = new Set<StreamRule>()
  private lastFired: { word: string; t: number } | null = null

  constructor(options: { dictionary?: Dictionary; rules?: readonly StreamRule[] } = {}) {
    this.lexicon = new LexiconMatcher(options.dictionary)
    this.rules = options.rules ?? []
    this.dictionaryWords = (options.dictionary?.signs ?? []).map((s) => s.gloss.toLowerCase())
  }

  /** How many signs it can recognize: the dictionary's (those that compiled) plus the rules. */
  get size(): number {
    return this.lexicon.size + this.rules.length
  }

  /** The words it can produce, lower case. */
  get words(): string[] {
    return [...new Set([...this.dictionaryWords, ...this.rules.map((r) => r.word)])]
  }

  /** A dictionary sign's start (its handshape held where it begins) is in view: a movement now may be that sign. */
  get armed(): boolean {
    return this.lexicon.armed
  }

  /** The face box in use (held across frames without one). */
  get faceBox(): FaceBox | undefined {
    return this.face?.box
  }

  /** Dev diagnostics: what the dictionary matcher saw on the last frame, the face, the last word. */
  get debug(): string {
    const face = this.face ? `face ${this.face.box.w.toFixed(2)}x${this.face.box.h.toFixed(2)}` : 'no face'
    const last = this.lastFired ? ` · last ${this.lastFired.word}` : ''
    return `${this.lexicon.debug || 'not fed yet'} · ${face}${last}`
  }

  /** Forget the history (the camera changed, a control gesture acted). Cooldowns stay. */
  reset(): void {
    this.history = []
    this.lexicon.reset()
  }

  /**
   * Feeds one frame. Returns the word (lower case) that just fired, or null. With `mayFire`
   * false (a control gesture's hold is timing toward firing) the frame still goes into the
   * history, but no word fires on it.
   */
  update(frame: FrameSample, aspect: number, mayFire = true): string | null {
    const box = faceBoxOf(frame.face)
    if (box) this.face = { box, t: frame.t }
    else if (this.face && frame.t - this.face.t > FACE_HOLD_MS) this.face = null
    const face = this.face?.box
    this.history.push(frame)
    while (this.history.length > 1 && frame.t - this.history[0].t > STREAM_HISTORY_MS) this.history.shift()

    // The dictionary matcher is fed every frame, so its own motion history never goes stale.
    const gloss = this.lexicon.update(frame, aspect, face)
    let word = mayFire && gloss && this.ready(gloss.toLowerCase(), frame.t) ? gloss.toLowerCase() : null
    if (!word && mayFire && frame.hands.length > 0) {
      const ctx: StreamContext = face ? { aspect, face } : { aspect }
      word = this.rules.find((rule) => this.ready(rule.word, frame.t) && this.check(rule, ctx))?.word ?? null
    }
    if (!word) return null
    this.lastFireT = frame.t
    this.lastFired = { word, t: frame.t }
    this.cooldownUntil.set(word, frame.t + STREAM_COOLDOWN_MS)
    this.history = []
    this.lexicon.reset()
    return word
  }

  private ready(word: string, t: number): boolean {
    return t - this.lastFireT >= STREAM_GAP_MS && t >= (this.cooldownUntil.get(word) ?? -Infinity)
  }

  private check(rule: StreamRule, ctx: StreamContext): boolean {
    try {
      return rule.fires(this.history, ctx)
    } catch (err) {
      if (!this.warned.has(rule)) {
        this.warned.add(rule)
        console.warn(`[stream] rule "${rule.word}" failed, skipped:`, err)
      }
      return false
    }
  }
}
