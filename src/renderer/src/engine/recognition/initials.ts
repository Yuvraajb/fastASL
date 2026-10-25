import { analyzeHand, fingerCount } from '../gestures/handShape'
import type { FrameSample } from '../types'

/**
 * Fingerspelled initials that need no teaching, for contact nicknames (CALL D W, MEETING D W).
 * Letters are otherwise recognized only from taught templates, and live D and W had never been
 * taught, so nothing came. Two letters have shapes the hand-shape analysis already tells apart:
 *  - D: only the index finger up (finger count 1; in D the thumb meets the middle finger);
 *  - W: index, middle and ring up, pinky down (finger count 3; the thumb holds the pinky).
 * The caller only asks right after CALL / MEETING or an initial (see recognitionInput), so a
 * pointing finger elsewhere is no D.
 */
export const INITIAL_SHAPES: Readonly<Record<string, number>> = { D: 1, W: 3 }

/** How long the shape must be held, one hand, still. */
export const INITIAL_HOLD_MS = 500
/** Wrist travel (fractions of frame height) that restarts the hold: the hand is moving, not spelling. */
const STILL_TRAVEL = 0.06

export class InitialsSpotter {
  private held: { letter: string; since: number; x: number; y: number } | null = null
  /** The letter just fired: it fires again only after the hand changes shape or leaves. */
  private fired: string | null = null

  /** Feeds one frame. Returns the letter (D or W) the moment it has been held long enough, else null. */
  update(frame: FrameSample, aspect: number, letters: readonly string[]): string | null {
    const letter = frame.hands.length === 1 ? letterOf(frame, aspect, letters) : null
    if (!letter) {
      this.reset()
      return null
    }
    const wrist = frame.hands[0].landmarks[0]
    const moved = this.held && Math.hypot((wrist.x - this.held.x) * aspect, wrist.y - this.held.y) > STILL_TRAVEL
    if (!this.held || this.held.letter !== letter || moved) {
      if (this.held?.letter !== letter) this.fired = null
      this.held = { letter, since: frame.t, x: wrist.x, y: wrist.y }
      return null
    }
    if (this.fired === letter || frame.t - this.held.since < INITIAL_HOLD_MS) return null
    this.fired = letter
    return letter
  }

  reset(): void {
    this.held = null
    this.fired = null
  }
}

function letterOf(frame: FrameSample, aspect: number, letters: readonly string[]): string | null {
  const count = fingerCount(analyzeHand(frame.hands[0], aspect))
  return letters.find((l) => INITIAL_SHAPES[l] !== undefined && INITIAL_SHAPES[l] === count) ?? null
}
