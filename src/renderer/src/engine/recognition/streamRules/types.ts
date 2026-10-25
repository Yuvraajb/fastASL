import type { FrameSample } from '../../types'
/** Face bounding box in normalized image coords (0..1), from the FaceLandmarker points. */
export type { FaceBox } from '../../types'
import type { FaceBox } from '../../types'
export interface StreamContext { aspect: number; face?: FaceBox }
export interface StreamRule {
  /** Display word, lower case: 'thank you'. */
  word: string
  hands: 1 | 2
  /** Called every frame with the recent history (oldest first, at most ~1.5 s, the current frame last). True the moment the sign is complete enough to commit. Must be cheap and pure. */
  fires(history: readonly FrameSample[], ctx: StreamContext): boolean
}
