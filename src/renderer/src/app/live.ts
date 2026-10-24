import type { Handedness, Landmark } from '@shared/types'

/**
 * High-frequency data (every camera frame). Kept outside React state on purpose:
 * canvases and the activity bars read it inside requestAnimationFrame.
 */
export interface LiveHand {
  landmarks: Landmark[]
  handedness: Handedness
}

export interface LiveFrame {
  /** Current camera frame (video element, MJPEG <img>, or null when the camera is off). */
  source: CanvasImageSource | null
  sourceWidth: number
  sourceHeight: number
  /** Hands in normalized image coordinates (0..1, NOT mirrored). */
  hands: LiveHand[]
  /** Smoothed hand-motion energy 0..1 that drives the activity bars. */
  motion: number
  /** Camera + tracking frames per second (dev readout). */
  fps: number
  /** True while the feed shows the built-in mock hand (Phase 1, screenshots, no camera). */
  mock: boolean
  /** Name of the mock pose to render when `mock` is true. */
  mockPose: MockPose
  /** True when the camera is unavailable (permission denied, bad URL...). */
  error: string | null
}

export type MockPose = 'palm' | 'fist' | 'c' | 'thumbsUp' | 'point' | 'ok' | 'peace' | 'twoHands'

export const live: LiveFrame = {
  source: null,
  sourceWidth: 0,
  sourceHeight: 0,
  hands: [],
  motion: 0,
  fps: 0,
  mock: true,
  mockPose: 'palm',
  error: null
}
