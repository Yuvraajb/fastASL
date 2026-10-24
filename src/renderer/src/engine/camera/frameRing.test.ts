import { describe, expect, it } from 'vitest'
import { FrameRing, pickFrames, type CapturedFrame, type FrameEncoder } from './frameRing'

const SOURCE = {} as CanvasImageSource

/** An encoder that records each draw and returns its number as the "JPEG". */
function recordingEncoder() {
  const draws: { width: number; height: number; quality: number }[] = []
  const encode: FrameEncoder = (_source, width, height, quality) => {
    draws.push({ width, height, quality })
    return `jpeg${draws.length}`
  }
  return { encode, draws }
}

/** Offers a 30 fps camera's frames from `from` for `ms`. */
function feed(ring: FrameRing, from: number, ms: number, size: [number, number] = [1280, 720]): void {
  for (let t = from; t < from + ms; t += 1000 / 30) ring.offer(SOURCE, size[0], size[1], t)
}

const frames = (...ts: number[]): CapturedFrame[] => ts.map((t) => ({ t, jpeg: `at${t}` }))

describe('FrameRing', () => {
  it('keeps about 8 frames a second of a 30 fps camera, 288 px wide at the camera’s aspect', () => {
    const { encode, draws } = recordingEncoder()
    const ring = new FrameRing(encode)
    feed(ring, 0, 1000)
    expect(ring.all.length).toBeGreaterThanOrEqual(7)
    expect(ring.all.length).toBeLessThanOrEqual(9)
    expect(draws[0]).toEqual({ width: 288, height: 162, quality: 0.7 })
    // Only kept frames are drawn: the other 22 cost nothing.
    expect(draws).toHaveLength(ring.all.length)
    const gaps = ring.all.slice(1).map((f, i) => f.t - ring.all[i].t)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(113)
  })

  it('keeps only the last 4 s', () => {
    const ring = new FrameRing(recordingEncoder().encode)
    feed(ring, 0, 10_000)
    const newest = ring.all[ring.all.length - 1].t
    expect(ring.all[0].t).toBeGreaterThanOrEqual(newest - 4000)
    expect(ring.all.length).toBeLessThanOrEqual(33)
  })

  it('skips frames it cannot encode or size, and starts over when the clock goes back (a new camera)', () => {
    const ring = new FrameRing(() => null)
    feed(ring, 0, 500)
    expect(ring.all).toHaveLength(0)

    const ok = new FrameRing(recordingEncoder().encode)
    ok.offer(SOURCE, 0, 0, 0)
    expect(ok.all).toHaveLength(0)
    feed(ok, 5000, 500)
    expect(ok.all.length).toBeGreaterThan(0)
    ok.offer(SOURCE, 640, 480, 100)
    expect(ok.all.map((f) => f.t)).toEqual([100])
  })
})

describe('pickFrames', () => {
  it('takes the frames from 100 ms before the movement to 100 ms after it', () => {
    const ring = frames(...Array.from({ length: 20 }, (_, i) => i * 125))
    expect(pickFrames(ring, 400, 1000).map((f) => f.t)).toEqual([375, 500, 625, 750, 875, 1000])
  })

  it('widens the window for a short movement until it holds 6 frames, by at most 400 ms each side', () => {
    const ring = frames(...Array.from({ length: 20 }, (_, i) => i * 125))
    // 300..600 holds 4 frames at a 100 ms pad; 200 ms each side gives 6.
    expect(pickFrames(ring, 300, 600).map((f) => f.t)).toEqual([125, 250, 375, 500, 625, 750])
    // A slow camera: even 400 ms each side holds fewer, and that is what is sent.
    const sparse = frames(0, 500, 1000, 1500, 2000)
    expect(pickFrames(sparse, 900, 1100).map((f) => f.t)).toEqual([500, 1000, 1500])
  })

  it('spreads at most 8 evenly, always keeping the first and the last', () => {
    const ring = frames(...Array.from({ length: 20 }, (_, i) => i * 125))
    const picked = pickFrames(ring, 100, 2300).map((f) => f.t)
    expect(picked).toHaveLength(8)
    expect(picked[0]).toBe(0)
    expect(picked[7]).toBe(2375)
    expect(picked).toEqual([...picked].sort((a, b) => a - b))
    expect(pickFrames(ring, 100, 2300, { count: 6 })).toHaveLength(6)
  })

  it('gives what there is when the movement has few frames, and nothing far outside it', () => {
    expect(pickFrames(frames(0, 125, 250), 100, 150).map((f) => f.t)).toEqual([0, 125, 250])
    expect(pickFrames(frames(0, 125), 1000, 2000)).toEqual([])
  })
})
