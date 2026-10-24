/**
 * MediaPipe hand landmark topology (21 points), shared by the feed renderer and
 * the real tracker in Phase 2.
 *
 *  0 wrist
 *  1-4   thumb  (CMC, MCP, IP, TIP)
 *  5-8   index  (MCP, PIP, DIP, TIP)
 *  9-12  middle
 *  13-16 ring
 *  17-20 pinky
 */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
]

/** Landmark chains per finger, base to tip: thumb, index, middle, ring, pinky. */
export const FINGERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20]
]

export const FINGER_TIPS: ReadonlySet<number> = new Set([4, 8, 12, 16, 20])
