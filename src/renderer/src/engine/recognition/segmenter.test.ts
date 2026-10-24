import { describe, expect, it } from 'vitest'
import type { FrameSample, HandSample } from '../types'
import { euclidean } from './dtw'
import { FRAME_FEATURE_DIM, STATIC_FEATURE_DIM } from './features'
import { DEFAULT_THRESHOLDS, Segmenter, type Segment } from './segmenter'
import { emptyFrames, performHolds, performSign, poseLandmarks, rng, SHAPES, WORDS, type HoldStep, type SignSpec } from './synthetic'

const ASPECT = 4 / 3

function run(frames: FrameSample[], seg = new Segmenter({}, ASPECT)): (Segment & { at: number })[] {
  return frames.flatMap((f) => seg.push(f).map((s) => ({ ...s, at: f.t })))
}

const kinds = (segments: Segment[]): string[] => segments.map((s) => (s.kind === 'cancel' ? `cancel:${s.reason}` : s.kind))

function holds(steps: HoldStep[], seed = 1, extra: Partial<Parameters<typeof performHolds>[1]> = {}): FrameSample[] {
  return performHolds(steps, { random: rng(seed), variation: 0.5, aspect: ASPECT, ...extra })
}

function sign(spec: SignSpec, seed = 1, extra: Partial<Parameters<typeof performSign>[1]> = {}): FrameSample[] {
  return performSign(spec, { random: rng(seed), variation: 0.5, aspect: ASPECT, dropout: 0, ...extra })
}

const statics = (segments: Segment[]): number[][] => segments.flatMap((s) => (s.kind === 'static' ? [s.features] : []))

/** The frames, then the hands gone for a second. */
const thenGone = (frames: FrameSample[]): FrameSample[] => [...frames, ...emptyFrames(frames[frames.length - 1].t + 33, 1000)]

/** [entered, left] of each movement's outcome. */
const edges = (segments: Segment[]): [boolean, boolean][] =>
  segments.flatMap((s) => (s.kind === 'dynamic' || s.kind === 'cancel' ? [[s.entered, s.left] as [boolean, boolean]] : []))

describe('dynamic segmentation', () => {
  it('emits start, then one segment once the hands have been still for 400 ms', () => {
    const frames = sign(WORDS.HELLO, 1, { restBeforeMs: 300, restAfterMs: 900 })
    const out = run(frames).filter((s) => s.kind !== 'static')
    expect(kinds(out)).toEqual(['start', 'dynamic'])
    const [start, end] = out
    if (end.kind !== 'dynamic') throw new Error('expected a dynamic segment')
    expect(start.at).toBeGreaterThan(300)
    expect(start.at).toBeLessThan(600)
    const last = end.frames[end.frames.length - 1].t
    expect(end.at - last).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.stillMs - DEFAULT_THRESHOLDS.tailMs - 40)
    expect(end.durationMs).toBe(last - end.frames[0].t)
    expect(end.durationMs).toBeGreaterThan(500)
    expect(end.durationMs).toBeLessThan(1200)
    expect(end.features).toHaveLength(end.frames.length)
    expect(end.features.every((f) => f.length === FRAME_FEATURE_DIM)).toBe(true)
  })

  it('ends a sign as soon as the hands leave, without waiting for stillness', () => {
    const motion = sign(WORDS.PLAY, 2, { restAfterMs: 0 })
    const gone = emptyFrames(motion[motion.length - 1].t + 33, 600)
    const out = run([...motion, ...gone]).filter((s) => s.kind !== 'static')
    expect(kinds(out)).toEqual(['start', 'dynamic'])
    expect(out[1].at - gone[0].t).toBeLessThan(DEFAULT_THRESHOLDS.stillMs)
  })

  it('cancels a twitch as too short', () => {
    const twitch: SignSpec = { durationMs: 120, hands: [{ handedness: 'Right', shape: 'B', path: (u) => [0.8 * u, 0] }] }
    expect(kinds(run(sign(twitch, 3, { variation: 0 })).filter((s) => s.kind !== 'static'))).toEqual(['start', 'cancel:too-short'])
  })

  it('cancels endless motion as too long, then waits for stillness before the next sign', () => {
    const circling: SignSpec = {
      durationMs: 6000,
      hands: [{ handedness: 'Right', shape: 'B', path: (u) => [Math.cos(12 * Math.PI * u) - 1, Math.sin(12 * Math.PI * u)] }]
    }
    const out = run(sign(circling, 4, { variation: 0 })).filter((s) => s.kind !== 'static')
    expect(kinds(out)).toEqual(['start', 'cancel:too-long'])
  })

  it('ignores movement outside the signing zone', () => {
    const frames: FrameSample[] = Array.from({ length: 40 }, (_, i) => ({
      t: i * 33,
      hands: [
        {
          handedness: 'Right',
          score: 1,
          landmarks: poseLandmarks(
            { shape: SHAPES.B, handedness: 'Right', x: 0.01, y: 0.3 + 0.3 * Math.sin(i / 3), size: 0.17, roll: 0, pitch: 0, yaw: 0 },
            ASPECT
          )
        }
      ]
    }))
    expect(run(frames)).toEqual([])
  })

  it('does not mistake jitter for motion when frames arrive in bursts', () => {
    // Pairs of frames 4 ms apart (an MJPEG stream catching up) over a still hand.
    const still = holds([{ shape: 'B', holdMs: 3000 }], 11, { variation: 0 })
    const bursty = still.map((f, i) => ({ ...f, t: i % 2 ? still[i - 1].t + 4 : f.t }))
    expect(run(bursty).filter((s) => s.kind === 'start')).toEqual([])
  })

  it('segments two-handed signs', () => {
    const out = run(sign(WORDS.MEETING, 5)).filter((s) => s.kind === 'dynamic')
    expect(out).toHaveLength(1)
  })

  it('does not mistake two hands that MediaPipe labels the same for motion', () => {
    // Confidence order flips from frame to frame; slotting by score alone swapped them.
    const r = rng(14)
    const shift = (h: HandSample, dx: number): HandSample => ({
      ...h,
      score: 0.93 + 0.04 * r(),
      landmarks: h.landmarks.map((p) => ({ ...p, x: p.x + dx }))
    })
    const one = holds([{ shape: 'B', holdMs: 6000 }], 15, { variation: 0 })
    expect(run(one.map((f) => ({ t: f.t, hands: f.hands.flatMap((h) => [shift(h, -0.15), shift(h, 0.15)]) })))).toEqual([])
  })

  it('works for small hands with noisy tracking (far from the camera)', () => {
    const far = { handSize: 0.1, noise: 0.004 }
    expect(kinds(run(sign(WORDS.HELLO, 16, far))).filter((k) => k !== 'static')).toEqual(['start', 'dynamic'])
    const still = holds([{ shape: 'B', holdMs: 6000 }], 17, far)
    const out = run(still)
    expect(kinds(out)).toEqual(['static'])
    expect(out[0].at - still[0].t).toBeLessThan(1000)
  })

  it('ignores an unusable aspect ratio, such as 0/0 from a feed with no size yet', () => {
    const frames = [...sign(WORDS.HELLO, 18), ...holds([{ shape: 'L', holdMs: 900 }], 19, { t0: 3000 })]
    expect(kinds(run(frames, new Segmenter({}, 0 / 0)))).toEqual(['start', 'dynamic', 'static', 'static'])
    const sized = new Segmenter({}, ASPECT)
    for (const bad of [0 / 0, 0, -1, Infinity]) sized.setAspect(bad)
    expect(run(frames, sized)).toEqual(run(frames))
  })
})

describe('raising and lowering the hands', () => {
  it('flags a movement that starts as the hand comes into view, and one that ends with it leaving', () => {
    const frames = thenGone(holds([{ shape: 'L', holdMs: 1500 }], 20, { raiseMs: 350, lowerMs: 300 }))
    expect(edges(run(frames))).toEqual([
      [true, false],
      [false, true]
    ])
  })

  it('does not flag a sign made after a pause', () => {
    const frames = thenGone(sign(WORDS.HELLO, 21, { raiseMs: 350, restBeforeMs: 500, restAfterMs: 500, lowerMs: 300 }))
    expect(edges(run(frames))).toEqual([
      [true, false],
      [false, false],
      [false, true]
    ])
  })

  it('reads a letter held right after raising the hand', () => {
    expect(statics(run(holds([{ shape: 'L', holdMs: 1500 }], 22, { raiseMs: 350 })))).toHaveLength(1)
  })
})

describe('static holds', () => {
  it('emits one averaged handshape after holding still for 0.5 s', () => {
    const frames = holds([{ shape: 'L', holdMs: 2000 }])
    const out = run(frames)
    expect(kinds(out)).toEqual(['static'])
    expect(out[0].at - frames[0].t).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.staticHoldMs)
    expect(out[0].at - frames[0].t).toBeLessThan(DEFAULT_THRESHOLDS.staticHoldMs + 100)
    expect(statics(out)[0]).toHaveLength(STATIC_FEATURE_DIM)
  })

  it('re-arms when the shape changes', () => {
    const out = statics(run(holds([{ shape: 'A', holdMs: 900 }, { shape: 'B', holdMs: 900 }, { shape: 'A', holdMs: 900 }])))
    expect(out).toHaveLength(3)
    expect(euclidean(out[0], out[2])).toBeLessThan(DEFAULT_THRESHOLDS.rearmShape)
    expect(euclidean(out[0], out[1])).toBeGreaterThan(DEFAULT_THRESHOLDS.rearmShape)
  })

  it('emits a double letter when the hand slides or dips and returns', () => {
    const slide = holds([{ shape: 'L', holdMs: 900 }, { shape: 'L', holdMs: 900, at: [0.9, 0] }])
    expect(statics(run(slide))).toHaveLength(2)
    const afterLongHold = holds([{ shape: 'L', holdMs: 2200 }, { shape: 'L', holdMs: 900, at: [0.9, 0] }], 3)
    expect(statics(run(afterLongHold))).toHaveLength(2)
    const dip = holds(
      [{ shape: 'L', holdMs: 900 }, { shape: 'L', holdMs: 0, at: [0, 1.2] }, { shape: 'L', holdMs: 900 }],
      2,
      { transitionMs: 150 }
    )
    expect(statics(run(dip))).toHaveLength(2)
  })

  it('re-arms when the hand leaves and comes back', () => {
    const first = holds([{ shape: 'L', holdMs: 900 }], 3)
    const gap = emptyFrames(first[first.length - 1].t + 33, 400)
    const second = holds([{ shape: 'L', holdMs: 900 }], 4, { t0: gap[gap.length - 1].t + 33 })
    expect(statics(run([...first, ...gap, ...second]))).toHaveLength(2)
  })

  it('tolerates dropped tracking frames during a hold', () => {
    expect(statics(run(holds([{ shape: 'V', holdMs: 1500 }], 5, { dropout: 0.15 })))).toHaveLength(1)
  })

  it('does not re-emit a held letter when MediaPipe flips the handedness label for a frame', () => {
    const frames = holds([{ shape: 'L', holdMs: 2500 }], 12)
    const flipped = frames.map((f, i) =>
      i === 30 || i === 31 ? { ...f, hands: f.hands.map((h) => ({ ...h, handedness: 'Left' as const })) } : f
    )
    expect(statics(run(flipped))).toHaveLength(1)
  })

  it('needs exactly one hand', () => {
    const one = holds([{ shape: 'L', holdMs: 1500 }], 6)
    const other = holds([{ shape: 'B', holdMs: 1500 }], 7)
    const both = one.map((f, i) => ({ t: f.t, hands: [...f.hands, ...(other[i]?.hands ?? []).map((h) => ({ ...h, handedness: 'Left' as const }))] }))
    expect(statics(run(both))).toEqual([])
  })

  it('emits the hold after a movement on a later frame, so blockStatic() can still stop it', () => {
    const frames = sign(WORDS.TOMORROW, 8, { restAfterMs: 2000 })
    const out = run(frames)
    const end = out.findIndex((s) => s.kind === 'dynamic')
    expect(kinds(out.slice(end))).toEqual(['dynamic', 'static'])
    expect(out[end + 1].at).toBeGreaterThan(out[end].at)

    const seg = new Segmenter({}, ASPECT)
    const blocked = frames.flatMap((f) =>
      seg.push(f).map((s) => {
        if (s.kind === 'dynamic') seg.blockStatic()
        return s
      })
    )
    expect(kinds(blocked)).toEqual(['start', 'dynamic'])
  })

  it('after reset(), a shape that is still held is not emitted until it changes', () => {
    const seg = new Segmenter({}, ASPECT)
    const frames = holds([{ shape: 'A', holdMs: 1500 }, { shape: 'Y', holdMs: 900 }], 9)
    const split = frames.findIndex((f) => f.t > 200)
    run(frames.slice(0, split), seg)
    seg.reset()
    const out = statics(run(frames.slice(split), seg))
    expect(out).toHaveLength(1) // only the Y
  })

  it('scales hold time through setThresholds', () => {
    const seg = new Segmenter({}, ASPECT)
    seg.setThresholds({ staticHoldMs: 1200 })
    const frames = holds([{ shape: 'L', holdMs: 2000 }], 10)
    const out = run(frames, seg)
    expect(out).toHaveLength(1)
    expect(out[0].at - frames[0].t).toBeGreaterThanOrEqual(1200)
  })
})
