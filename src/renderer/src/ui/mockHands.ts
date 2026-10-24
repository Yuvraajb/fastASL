import type { Handedness, Landmark } from '@shared/types'
import type { LiveHand, MockPose } from '../app/live'
import { FINGER_TIPS } from './handConnections'

/** Virtual camera frame the mock landmarks live in (4:3, like most webcams). */
export const MOCK_FRAME = { width: 640, height: 480 } as const

export interface MockHand extends LiveHand {
  /** Finger thickness as a fraction of the frame width (used only to draw the silhouette). */
  fingerWidth: number
  /** Per-finger thickness multipliers (thumb..pinky) on top of the default proportions. */
  fingerScale?: readonly number[]
}

/** [x, y, z]: x/y in display-space px of the 640x480 frame (as seen in the mirrored feed), z like MediaPipe. */
type P = readonly [number, number, number]

// Poses are authored as they appear on screen (mirrored), then converted to raw,
// un-mirrored MediaPipe coordinates below. Thumb sits on the right of the screen.

const PALM: P[] = [
  [320, 405, 0],
  [358, 380, -0.02], [392, 352, -0.035], [417, 326, -0.045], [437, 302, -0.055],
  [354, 290, -0.01], [365, 241, -0.02], [371, 211, -0.027], [376, 186, -0.032],
  [321, 283, -0.008], [323, 229, -0.018], [324, 195, -0.025], [325, 168, -0.03],
  [290, 291, -0.008], [282, 242, -0.016], [277, 211, -0.022], [273, 186, -0.027],
  [262, 305, -0.006], [245, 268, -0.012], [236, 246, -0.016], [228, 226, -0.02]
]

/** ASL "A": fist facing the camera, thumb up along the side of the index. */
const FIST: P[] = [
  [322, 422, 0],
  [356, 398, -0.02], [379, 368, -0.035], [385, 338, -0.045], [383, 310, -0.05],
  [350, 300, -0.012], [354, 272, -0.05], [352, 318, -0.07], [347, 338, -0.06],
  [325, 296, -0.01], [327, 266, -0.05], [325, 316, -0.07], [321, 336, -0.06],
  [300, 300, -0.008], [299, 270, -0.045], [298, 318, -0.062], [296, 336, -0.054],
  [277, 310, -0.006], [274, 286, -0.038], [275, 322, -0.05], [277, 338, -0.044]
]

/** ASL "C": side view, fingers curved over the top, thumb below, opening to the right. */
const C_HAND: P[] = [
  [240, 400, 0],
  [290, 384, -0.02], [330, 376, -0.03], [366, 366, -0.035], [396, 352, -0.038],
  [316, 300, -0.02], [350, 258, -0.03], [386, 252, -0.035], [410, 270, -0.036],
  [302, 290, -0.008], [338, 244, -0.012], [378, 234, -0.014], [406, 250, -0.015],
  [288, 288, 0.004], [324, 240, 0.004], [362, 230, 0.004], [390, 244, 0.004],
  [274, 292, 0.014], [306, 248, 0.016], [338, 236, 0.017], [362, 246, 0.018]
]

/**
 * Thumbs up, seen from the thumb side: the four fingers curl into one fist mass on
 * the left (knuckles out, tips tucked into the palm), a short thick thumb points up,
 * forearm to the bottom right.
 */
const THUMBS_UP: P[] = [
  [372, 372, 0],
  [350, 332, -0.02], [338, 302, -0.03], [336, 275, -0.035], [336, 251, -0.038],
  [322, 308, -0.015], [288, 306, -0.02], [292, 326, -0.022], [308, 330, -0.02],
  [326, 330, -0.01], [288, 330, -0.014], [293, 350, -0.016], [310, 352, -0.014],
  [332, 352, -0.004], [293, 354, -0.008], [298, 372, -0.01], [314, 372, -0.008],
  [340, 372, 0.004], [303, 376, 0], [308, 390, -0.002], [320, 390, 0]
]

/** Index pointing up, other fingers curled, thumb resting on the middle finger. */
const POINT: P[] = [
  [318, 418, 0],
  [350, 392, -0.02], [370, 362, -0.03], [366, 334, -0.045], [348, 318, -0.055],
  [342, 300, -0.012], [350, 248, -0.02], [355, 214, -0.025], [359, 186, -0.028],
  [315, 298, -0.01], [320, 266, -0.04], [326, 292, -0.052], [330, 312, -0.05],
  [290, 304, -0.008], [291, 274, -0.036], [296, 298, -0.046], [301, 316, -0.044],
  [268, 316, -0.006], [265, 292, -0.03], [270, 312, -0.038], [277, 326, -0.036]
]

/** OK sign: thumb and index form a ring, the other three fingers up. */
const OK: P[] = [
  [304, 420, 0],
  [336, 394, -0.02], [368, 374, -0.03], [396, 354, -0.04], [412, 326, -0.045],
  [342, 300, -0.012], [382, 266, -0.03], [414, 282, -0.042], [416, 312, -0.046],
  [316, 294, -0.01], [314, 242, -0.016], [312, 208, -0.02], [311, 182, -0.022],
  [292, 298, -0.008], [284, 250, -0.012], [279, 219, -0.015], [275, 195, -0.017],
  [270, 310, -0.006], [258, 274, -0.008], [251, 252, -0.01], [246, 232, -0.012]
]

/** Peace / V: index and middle up, ring and pinky curled under the thumb. */
const PEACE: P[] = [
  [320, 425, 0],
  [352, 398, -0.02], [368, 368, -0.03], [352, 340, -0.045], [326, 330, -0.05],
  [344, 304, -0.012], [362, 254, -0.018], [373, 222, -0.022], [381, 194, -0.025],
  [317, 298, -0.01], [306, 244, -0.016], [300, 210, -0.02], [295, 182, -0.022],
  [292, 306, -0.008], [292, 278, -0.036], [300, 302, -0.046], [306, 318, -0.044],
  [270, 318, -0.006], [268, 294, -0.03], [276, 314, -0.038], [284, 328, -0.036]
]

/** Finger thickness in frame px before scaling. */
const FINGER_PX = 27

interface Placement {
  dx?: number
  dy?: number
  scale?: number
  /** Radians, clockwise on screen. */
  rot?: number
  /** Mirror the hand about its wrist (left <-> right hand). */
  flip?: boolean
}

/** Scale / rotate a pose about its wrist, then move it. */
function place(pts: P[], { dx = 0, dy = 0, scale = 1, rot = 0, flip = false }: Placement): P[] {
  const [wx, wy] = pts[0]
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  return pts.map(([x, y, z]) => {
    const px = (flip ? wx - x : x - wx) * scale
    const py = (y - wy) * scale
    return [wx + px * c - py * s + dx, wy + px * s + py * c + dy, z * scale] as const
  })
}

/**
 * `thickness` widens the fingers for side views and fists, where they overlap into one
 * mass; `fingerScale` adjusts single fingers (e.g. a thicker thumb).
 */
function hand(pts: P[], handedness: Handedness, placement: Placement, thickness = 1, fingerScale?: readonly number[]): MockHand {
  const placed = place(pts, placement)
  return {
    // Display space -> raw camera space: un-mirror x, normalize to 0..1.
    landmarks: placed.map(([x, y, z]) => ({ x: 1 - x / MOCK_FRAME.width, y: y / MOCK_FRAME.height, z })),
    handedness,
    fingerWidth: (FINGER_PX * thickness * (placement.scale ?? 1)) / MOCK_FRAME.width,
    fingerScale
  }
}

/** Static mock hands per pose: normalized 0..1 image coordinates, NOT mirrored (like MediaPipe output). */
export const MOCK_HANDS: Record<MockPose, readonly MockHand[]> = {
  palm: [hand(PALM, 'Right', { scale: 1.2, dy: 20 })],
  fist: [hand(FIST, 'Right', { scale: 1.3, dy: 8 }, 1.15)],
  c: [hand(C_HAND, 'Right', { scale: 1.45, dx: -14, dy: 28 }, 1.15)],
  thumbsUp: [hand(THUMBS_UP, 'Right', { scale: 1.4, dx: -6, dy: 22, rot: 0.24 }, 1.25, [1.12, 1, 1, 1, 1])],
  point: [hand(POINT, 'Right', { scale: 1.2, dy: 10 })],
  ok: [hand(OK, 'Right', { scale: 1.2, dx: 6, dy: 8 })],
  peace: [hand(PEACE, 'Right', { scale: 1.2, dy: 6 })],
  twoHands: [
    hand(FIST, 'Left', { dx: -118, dy: -8, scale: 1.12, rot: 0.14 }, 1.15),
    hand(POINT, 'Right', { dx: 112, dy: -16, scale: 1.12, rot: -0.3, flip: true })
  ]
}

/**
 * The mock hands for `pose` at time `t` (seconds), with a gentle idle drift so the
 * feed looks alive: a slow sway about the wrist plus a tiny fingertip wiggle.
 */
export function animateMockHands(pose: MockPose, t: number): MockHand[] {
  const { width: fw, height: fh } = MOCK_FRAME
  return MOCK_HANDS[pose].map((h, k) => {
    const phase = k * 1.7
    const dx = 0.004 * Math.sin(t * 0.9 + phase)
    const dy = 0.005 * Math.sin(t * 0.7 + 1 + phase)
    const rot = 0.018 * Math.sin(t * 0.5 + phase)
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const wrist = h.landmarks[0]
    const landmarks: Landmark[] = h.landmarks.map((p, i) => {
      // Rotate in frame px so the 4:3 aspect doesn't skew the hand.
      const px = (p.x - wrist.x) * fw
      const py = (p.y - wrist.y) * fh
      let rx = px * c - py * s
      let ry = px * s + py * c
      if (FINGER_TIPS.has(i)) {
        rx += 1.2 * Math.sin(t * 1.3 + i)
        ry += 0.8 * Math.cos(t * 1.1 + i)
      }
      return { x: wrist.x + rx / fw + dx, y: wrist.y + ry / fh + dy, z: p.z }
    })
    return { ...h, landmarks }
  })
}
