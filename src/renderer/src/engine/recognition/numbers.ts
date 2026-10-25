import { analyzeHand, fingerCount } from '../gestures/handShape'
import type { FrameSample, HandSample } from '../types'

/*
 * ASL numbers 1-5: a hand held in the shape of a number. Standard handshapes, no recordings:
 * 1 index up, 2 index + middle, 3 thumb + index + middle (or index, middle, ring), 4 four
 * fingers with the thumb folded, 5 open hand. It fires as soon as the shape has been steady
 * for HOLD_MS, then waits for the hand to change shape or leave before it can fire again.
 * Ported from the asl-dictionary-chat branch (commit 220f562), plus `allow`: a shape that is a
 * control gesture in the current view (the peace sign in Ready) is not a number there.
 */

/** Whether a hand showing number `n` may be read as that number (default: always). */
export type NumberGate = (hand: HandSample, n: number) => boolean

/** How long the same number must be steady before it counts. */
export const NUMBER_HOLD_MS = 250
/** Share of the frames in that window that must show the number (landmark jitter flickers single frames). */
const STEADY_SHARE = 0.8

export class NumberMatcher {
  private window: { t: number; n: number | null }[] = []
  private fired: number | null = null

  reset(): void {
    this.window = []
    this.fired = null
  }

  /** The number just recognized (1-5), or null. */
  update(frame: FrameSample, aspect: number, allow?: NumberGate): number | null {
    const hand = frame.hands.length === 1 ? frame.hands[0] : null
    const count = hand ? fingerCount(analyzeHand(hand, aspect)) : null
    const n = hand && count !== null && (!allow || allow(hand, count)) ? count : null
    this.window.push({ t: frame.t, n })
    while (this.window.length > 1 && frame.t - this.window[0].t > NUMBER_HOLD_MS * 2) this.window.shift()

    // Re-arm once the hand shows a different number, or has been gone or shapeless for a moment.
    if (this.fired !== null && n !== this.fired) {
      const recent = this.window.filter((w) => frame.t - w.t <= NUMBER_HOLD_MS)
      if (!recent.some((w) => w.n === this.fired)) this.fired = null
    }
    if (n === null || n === this.fired) return null

    const span = this.window.filter((w) => frame.t - w.t <= NUMBER_HOLD_MS)
    if (span.length < 3 || frame.t - this.window[0].t < NUMBER_HOLD_MS * 0.9) return null
    if (span.filter((w) => w.n === n).length / span.length < STEADY_SHARE) return null
    this.fired = n
    return n
  }
}
