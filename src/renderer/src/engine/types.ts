import type { Handedness, Landmark, Sensitivity } from '@shared/types'

/** One tracked hand in one camera frame, as produced by MediaPipe HandLandmarker. */
export interface HandSample {
  /** 21 landmarks in normalized image coordinates (0..1), NOT mirrored. z is relative depth. */
  landmarks: Landmark[]
  /** MediaPipe handedness label (the person's own hand when the frame is not mirrored). */
  handedness: Handedness
  score: number
}

/** All hands seen in one frame. */
export interface FrameSample {
  /** Monotonic timestamp in milliseconds (performance.now()). */
  t: number
  hands: HandSample[]
}

/** Thresholds that the Settings > Sensitivity page scales. */
export interface SensitivityProfile {
  /** Multiplier on all hold times (low = longer holds). */
  holdScale: number
  /** Multiplier on swipe velocity thresholds (low = faster swipes required). */
  swipeScale: number
  /** Multiplier on recognition reject thresholds (high = accepts less certain matches). */
  acceptScale: number
}

export const SENSITIVITY: Record<Sensitivity, SensitivityProfile> = {
  low: { holdScale: 1.35, swipeScale: 1.3, acceptScale: 0.85 },
  medium: { holdScale: 1, swipeScale: 1, acceptScale: 1 },
  high: { holdScale: 0.75, swipeScale: 0.8, acceptScale: 1.2 }
}
