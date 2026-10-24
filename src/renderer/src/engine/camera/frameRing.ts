/*
 * The last few seconds of camera frames, small, for the LLM that guesses an unknown sign (guess,
 * confirm, learn). The recognizer only keeps landmarks; when a movement turns out to be no sign it
 * knows, the frames around it come from here. Frames stay in this renderer unless a guess sends
 * them (DECISIONS, "Guess, confirm, learn").
 */

/** One captured frame: when it was tracked (the FrameSample clock) and the JPEG, base64 without a data: prefix. */
export interface CapturedFrame {
  t: number
  jpeg: string
}

export interface FrameRingOptions {
  /** One frame per interval: 125 ms is 8 fps. */
  intervalMs: number
  /** Frames older than this (relative to the newest) are dropped. */
  keepMs: number
  /** Width of the stored JPEG; the height keeps the camera's aspect. */
  width: number
  /** JPEG quality, 0..1. */
  quality: number
}

export const FRAME_RING_DEFAULTS: FrameRingOptions = { intervalMs: 125, keepMs: 4000, width: 288, quality: 0.7 }

/** A frame arriving this early still counts as on time (camera frames come every ~33 ms, with jitter). */
const EARLY_MS = 12

/** Draws `source` at width x height and returns the JPEG base64, or null when it can't (no frame yet, a tainted canvas). */
export type FrameEncoder = (source: CanvasImageSource, width: number, height: number, quality: number) => string | null

const JPEG_PREFIX = /^data:image\/jpeg;base64,/

/** The renderer's encoder: one small reused canvas, toDataURL (about a millisecond at 288 px). */
export function canvasEncoder(): FrameEncoder {
  let canvas: HTMLCanvasElement | null = null
  return (source, width, height, quality) => {
    if (typeof document === 'undefined') return null
    canvas ??= document.createElement('canvas')
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    try {
      ctx.drawImage(source, 0, 0, width, height)
      const url = canvas.toDataURL('image/jpeg', quality)
      return JPEG_PREFIX.test(url) ? url.replace(JPEG_PREFIX, '') : null
    } catch {
      return null
    }
  }
}

export class FrameRing {
  private readonly options: FrameRingOptions
  private frames: CapturedFrame[] = []
  private lastT = -Infinity

  constructor(
    private readonly encode: FrameEncoder,
    options: Partial<FrameRingOptions> = {}
  ) {
    this.options = { ...FRAME_RING_DEFAULTS, ...options }
  }

  /**
   * Offers the frame tracked at `t`: kept when an interval has passed since the last one. Cheap
   * otherwise (nothing is drawn). Returns whether it was kept.
   */
  offer(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, t: number): boolean {
    const { intervalMs, keepMs, width, quality } = this.options
    if (t < this.lastT) this.clear() // a new clock (camera restarted): old frames can't be placed
    if (t - this.lastT < intervalMs - EARLY_MS || !(sourceWidth > 0 && sourceHeight > 0)) return false
    const height = Math.max(1, Math.round((width * sourceHeight) / sourceWidth))
    const jpeg = this.encode(source, width, height, quality)
    if (!jpeg) return false
    this.lastT = t
    this.frames.push({ t, jpeg })
    while (this.frames.length && this.frames[0].t < t - keepMs) this.frames.shift()
    return true
  }

  /** Every frame held, oldest first. */
  get all(): readonly CapturedFrame[] {
    return this.frames
  }

  clear(): void {
    this.frames = []
    this.lastT = -Infinity
  }
}

export interface PickOptions {
  /** Most frames to return (6 to 8 for a guess). */
  count: number
  /** Taken around the movement: before its first frame and after its last. */
  padMs: number
  /**
   * A short movement (or a slow camera) has few frames: the window then widens, padMs at a
   * time, up to maxPadMs, until it holds this many. The extra frames show where the hand
   * started and ended.
   */
  minCount: number
  maxPadMs: number
}

export const PICK_DEFAULTS: PickOptions = { count: 8, padMs: 100, minCount: 6, maxPadMs: 400 }

/**
 * Up to `count` frames spread evenly over [start - pad, end + pad], oldest first, with pad from
 * padMs up to maxPadMs until there are minCount. The first and last frames in the window are
 * always included, so the start and end handshapes show.
 */
export function pickFrames(
  frames: readonly CapturedFrame[],
  start: number,
  end: number,
  options: Partial<PickOptions> = {}
): CapturedFrame[] {
  const { count, padMs, minCount, maxPadMs } = { ...PICK_DEFAULTS, ...options }
  const within = (pad: number): CapturedFrame[] => frames.filter((f) => f.t >= start - pad && f.t <= end + pad)
  let pad = padMs
  let inside = within(pad)
  while (inside.length < Math.min(minCount, count) && pad < maxPadMs) {
    pad = Math.min(maxPadMs, pad + Math.max(padMs, 1))
    inside = within(pad)
  }
  if (inside.length <= count) return inside
  if (count <= 1) return inside.slice(0, Math.max(0, count))
  const picked: CapturedFrame[] = []
  for (let i = 0; i < count; i++) picked.push(inside[Math.round((i * (inside.length - 1)) / (count - 1))])
  return picked
}
