import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraSource, Landmark } from '@shared/types'
import type { LiveFrame } from '../../app/live'
import type { FrameSample, HandSample } from '../types'
import type { CameraHandle } from './cameraSource'
import { MissingAssetsError, type HandTracker } from './handTracker'
import { CameraPipeline, sameSource } from './pipeline'

const BUILTIN: CameraSource = { kind: 'builtin' }
const ESP32: CameraSource = { kind: 'mjpeg', url: 'http://192.168.4.1:81/stream' }

interface FakeHandle extends CameraHandle {
  error: string | null
  stop: ReturnType<typeof vi.fn>
}

function fakeHandle(source: CameraSource): FakeHandle {
  return {
    element: { id: `${source.kind}-element` } as unknown as HTMLCanvasElement,
    width: 640,
    height: 480,
    kind: source.kind,
    error: null,
    stop: vi.fn()
  }
}

function hand(x: number): HandSample {
  const landmarks: Landmark[] = Array.from({ length: 21 }, (_, i) => ({ x: x + (i % 5) * 0.02, y: 0.5 - i * 0.01, z: 0 }))
  return { landmarks, handedness: 'Right', score: 0.97 }
}

function freshLive(): LiveFrame {
  return { source: null, sourceWidth: 0, sourceHeight: 0, hands: [], motion: 0, fps: 0, mock: true, mockPose: 'palm', error: null }
}

function harness() {
  let now = 1000
  let pending: (() => void)[] = []
  let handX = 0.3
  const live = freshLive()
  const handles: FakeHandle[] = []
  const trackers: HandTracker[] = []
  let openImpl: (source: CameraSource) => Promise<FakeHandle> = async (source) => fakeHandle(source)

  const makeTracker = (): HandTracker => {
    const tracker = {
      delegate: 'GPU' as const,
      detect: vi.fn((_el: unknown, t: number): FrameSample => ({ t, hands: [hand(handX)] })),
      takeTimings: vi.fn(() => null),
      close: vi.fn()
    }
    trackers.push(tracker)
    return tracker
  }

  const deps = {
    live,
    now: () => now,
    openCamera: vi.fn(async (source: CameraSource) => {
      const h = await openImpl(source)
      handles.push(h)
      return h
    }),
    createHandTracker: vi.fn(async () => makeTracker()),
    nextFrame: (_h: CameraHandle, cb: () => void) => {
      pending.push(cb)
      return () => {
        pending = pending.filter((p) => p !== cb)
      }
    }
  }

  return {
    live,
    deps,
    handles,
    trackers,
    pipeline: new CameraPipeline(deps),
    setOpen: (impl: typeof openImpl) => (openImpl = impl),
    moveHand: (x: number) => (handX = x),
    pendingFrames: () => pending.length,
    /** Advance the clock by `ms` and deliver one frame. */
    frame(ms = 1000 / 30) {
      now += ms
      const due = pending
      pending = []
      for (const cb of due) cb()
    }
  }
}

describe('CameraPipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens the camera and publishes tracked hands to live and subscribers', async () => {
    const h = harness()
    const seen: FrameSample[] = []
    h.pipeline.subscribe((f) => seen.push(f))
    await h.pipeline.start(BUILTIN)
    expect(h.deps.openCamera).toHaveBeenCalledWith(BUILTIN)

    for (let i = 0; i < 10; i++) h.frame()

    expect(seen).toHaveLength(10)
    expect(h.live.mock).toBe(false)
    expect(h.live.error).toBeNull()
    expect(h.live.source).toBe(h.handles[0].element)
    expect([h.live.sourceWidth, h.live.sourceHeight]).toEqual([640, 480])
    expect(h.live.hands).toHaveLength(1)
    expect(h.live.hands[0]).toEqual({ landmarks: seen[9].hands[0].landmarks, handedness: 'Right' })
    expect(h.live.fps).toBeCloseTo(30, 0)
  })

  it('feeds hand motion into live.motion', async () => {
    const h = harness()
    await h.pipeline.start(BUILTIN)
    for (let i = 0; i < 10; i++) h.frame()
    expect(h.live.motion).toBe(0)
    for (let i = 0; i < 10; i++) {
      h.moveHand(0.3 + i * 0.02)
      h.frame()
    }
    expect(h.live.motion).toBeGreaterThan(0.2)
  })

  it('caps detection at ~30 per second on fast displays', async () => {
    const h = harness()
    await h.pipeline.start(ESP32)
    for (let i = 0; i < 120; i++) h.frame(1000 / 120)
    const calls = (h.trackers[0].detect as ReturnType<typeof vi.fn>).mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(28)
    expect(calls).toBeLessThanOrEqual(31)
  })

  it('keeps every frame of a 30 fps camera despite timing jitter', async () => {
    const h = harness()
    await h.pipeline.start(BUILTIN)
    for (let i = 0; i < 60; i++) h.frame(1000 / 30 + (i % 2 ? 6 : -6))
    expect(h.trackers[0].detect).toHaveBeenCalledTimes(60)
  })

  it('skips frames until the source has a size', async () => {
    const h = harness()
    h.setOpen(async (s) => ({ ...fakeHandle(s), width: 0, height: 0 }))
    await h.pipeline.start(BUILTIN)
    h.frame()
    expect(h.trackers[0].detect).not.toHaveBeenCalled()
    expect(h.pendingFrames()).toBe(1)
  })

  it('falls back to the mock hand when the camera fails, then retries with backoff', async () => {
    const h = harness()
    h.setOpen(async () => {
      throw new Error('Camera access denied')
    })
    await h.pipeline.start(BUILTIN)
    expect(h.live).toMatchObject({ mock: true, source: null, hands: [], error: 'Camera access denied' })

    await vi.advanceTimersByTimeAsync(1000)
    expect(h.deps.openCamera).toHaveBeenCalledTimes(2)
    expect(h.live.error).toBe('Camera access denied')
    await vi.advanceTimersByTimeAsync(1999)
    expect(h.deps.openCamera).toHaveBeenCalledTimes(2)

    h.setOpen(async (s) => fakeHandle(s))
    await vi.advanceTimersByTimeAsync(1)
    expect(h.deps.openCamera).toHaveBeenCalledTimes(3)
    h.frame()
    expect(h.live).toMatchObject({ mock: false, error: null })
  })

  it('keeps showing the last error while retrying the same source', async () => {
    const h = harness()
    h.setOpen(async () => {
      throw new Error('Lost the ESP32 stream')
    })
    await h.pipeline.start(ESP32)
    let resolveOpen!: (v: FakeHandle) => void
    h.setOpen(() => new Promise((r) => (resolveOpen = r)))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.deps.openCamera).toHaveBeenCalledTimes(2)
    expect(h.live).toMatchObject({ mock: true, error: 'Lost the ESP32 stream' })

    resolveOpen(fakeHandle(ESP32))
    await vi.advanceTimersByTimeAsync(0)
    h.frame()
    expect(h.live).toMatchObject({ mock: false, error: null })
  })

  it("drops the old source's error and backoff when switching sources", async () => {
    const h = harness()
    h.setOpen(async () => {
      throw new Error("Can't reach the ESP32 stream")
    })
    await h.pipeline.start(ESP32)
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000) // backoff has grown to 8s
    expect(h.deps.openCamera).toHaveBeenCalledTimes(4)

    // The built-in camera is slow to open (first-run permission prompt).
    let rejectOpen!: (err: Error) => void
    h.setOpen(() => new Promise((_, reject) => (rejectOpen = reject)))
    const switching = h.pipeline.setSource(BUILTIN)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.live.error).toBeNull()

    rejectOpen(new Error('Camera access denied'))
    await switching
    expect(h.live.error).toBe('Camera access denied')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.deps.openCamera).toHaveBeenCalledTimes(6)
    expect(h.deps.openCamera).toHaveBeenLastCalledWith(BUILTIN)
  })

  it('recovers when a running source dies', async () => {
    const h = harness()
    const seen: FrameSample[] = []
    h.pipeline.subscribe((f) => seen.push(f))
    await h.pipeline.start(ESP32)
    h.frame()
    expect(h.live.hands).toHaveLength(1)

    h.handles[0].error = 'Lost the ESP32 stream'
    h.frame()
    expect(h.handles[0].stop).toHaveBeenCalled()
    expect(h.live).toMatchObject({ mock: true, source: null, hands: [], error: 'Lost the ESP32 stream' })
    expect(seen.at(-1)?.hands).toEqual([])

    await vi.advanceTimersByTimeAsync(1000)
    h.frame()
    expect(h.handles).toHaveLength(2)
    expect(h.live).toMatchObject({ mock: false, source: h.handles[1].element, error: null })
  })

  it('reports the first frame of each session and every failure', async () => {
    const h = harness()
    const status: (string | null)[] = []
    h.pipeline.onStatus((error) => status.push(error))
    await h.pipeline.start(ESP32)
    h.frame()
    h.frame()
    expect(status).toEqual([null])

    h.handles[0].error = 'Lost the ESP32 stream'
    h.frame()
    h.setOpen(async () => {
      throw new Error("Can't reach the ESP32 stream")
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(status).toEqual([null, 'Lost the ESP32 stream', "Can't reach the ESP32 stream"])

    h.setOpen(async (s) => fakeHandle(s))
    await h.pipeline.setSource(BUILTIN)
    h.frame()
    expect(status.at(-1)).toBeNull()
  })

  it('a status listener that switches the source on a failure cancels the retry', async () => {
    const h = harness()
    h.setOpen(async (s) => {
      if (s.kind === 'mjpeg') throw new Error("Can't reach the ESP32 stream")
      return fakeHandle(s)
    })
    h.pipeline.onStatus((error) => {
      if (error) void h.pipeline.setSource(BUILTIN)
    })
    await h.pipeline.start(ESP32)
    await vi.advanceTimersByTimeAsync(0)
    h.frame()
    expect(h.live).toMatchObject({ mock: false, error: null, source: h.handles[0].element })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.deps.openCamera.mock.calls).toEqual([[ESP32], [BUILTIN]])
  })

  it('rebuilds the tracker after an inference error', async () => {
    const h = harness()
    await h.pipeline.start(BUILTIN)
    ;(h.trackers[0].detect as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('WebGL context lost')
    })
    h.frame()
    expect(h.trackers[0].close).toHaveBeenCalled()
    expect(h.live.error).toContain('WebGL context lost')

    await vi.advanceTimersByTimeAsync(1000)
    h.frame()
    expect(h.deps.createHandTracker).toHaveBeenCalledTimes(2)
    expect(h.live.mock).toBe(false)
  })

  it('never opens the camera while the tracker fails to load, and retries the tracker', async () => {
    const h = harness()
    h.deps.createHandTracker.mockRejectedValueOnce(new Error('wasm aborted')).mockRejectedValueOnce(new Error('wasm aborted'))
    await h.pipeline.start(BUILTIN)
    expect(h.live).toMatchObject({ mock: true, error: 'Hand tracking failed to load (wasm aborted)' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.deps.createHandTracker).toHaveBeenCalledTimes(2)
    expect(h.deps.openCamera).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(h.deps.openCamera).toHaveBeenCalledTimes(1)
    h.frame()
    expect(h.live).toMatchObject({ mock: false, error: null })
  })

  it('stops retrying when the MediaPipe files are missing, and tries again on a new source', async () => {
    const h = harness()
    h.deps.createHandTracker.mockRejectedValueOnce(new MissingAssetsError())
    await h.pipeline.start(BUILTIN)
    expect(h.live).toMatchObject({ mock: true, error: 'Hand tracking files are missing — run npm run setup' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.deps.createHandTracker).toHaveBeenCalledTimes(1)
    expect(h.deps.openCamera).not.toHaveBeenCalled()
    expect(h.live.error).toBe('Hand tracking files are missing — run npm run setup')

    await h.pipeline.setSource(ESP32)
    h.frame()
    expect(h.deps.openCamera).toHaveBeenCalledWith(ESP32)
    expect(h.live).toMatchObject({ mock: false, error: null })
  })

  it('setEnabled(false) closes the camera without an error and setEnabled(true) reopens it', async () => {
    const h = harness()
    await h.pipeline.start(BUILTIN)
    h.frame()
    await h.pipeline.setEnabled(false)
    expect(h.handles[0].stop).toHaveBeenCalled()
    expect(h.live).toMatchObject({ mock: true, source: null, hands: [], error: null, fps: 0, motion: 0 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.deps.openCamera).toHaveBeenCalledTimes(1)

    await h.pipeline.setEnabled(true)
    h.frame()
    expect(h.deps.openCamera).toHaveBeenCalledTimes(2)
    expect(h.live.mock).toBe(false)
  })

  it('does not open a camera while disabled', async () => {
    const h = harness()
    await h.pipeline.setEnabled(false)
    await h.pipeline.start(BUILTIN)
    expect(h.deps.openCamera).not.toHaveBeenCalled()
    expect(h.live.mock).toBe(true)
  })

  it('switches sources by closing the old handle and opening the new one', async () => {
    const h = harness()
    await h.pipeline.start(BUILTIN)
    h.frame()
    await h.pipeline.setSource({ kind: 'builtin' })
    expect(h.deps.openCamera).toHaveBeenCalledTimes(1)

    await h.pipeline.setSource(ESP32)
    expect(h.handles[0].stop).toHaveBeenCalled()
    expect(h.deps.openCamera).toHaveBeenLastCalledWith(ESP32)
    h.frame()
    expect(h.live.source).toBe(h.handles[1].element)
    expect(h.deps.createHandTracker).toHaveBeenCalledTimes(1)
  })

  it('does not open the camera when stop() comes while the tracker loads', async () => {
    const h = harness()
    let resolveTracker!: (t: HandTracker) => void
    h.deps.createHandTracker.mockImplementationOnce(() => new Promise((r) => (resolveTracker = r)))
    const started = h.pipeline.start(BUILTIN)
    h.pipeline.stop()
    resolveTracker({ delegate: 'GPU', detect: vi.fn(), takeTimings: vi.fn(() => null), close: vi.fn() })
    await started
    expect(h.deps.openCamera).not.toHaveBeenCalled()
    expect(h.live.mock).toBe(true)
  })

  it('closes a camera that finishes opening after stop()', async () => {
    const h = harness()
    let resolve!: (v: FakeHandle) => void
    h.setOpen(() => new Promise((r) => (resolve = r)))
    const started = h.pipeline.start(BUILTIN)
    await vi.advanceTimersByTimeAsync(0)
    h.pipeline.stop()
    const late = fakeHandle(BUILTIN)
    resolve(late)
    await started
    expect(late.stop).toHaveBeenCalled()
    expect(h.live.mock).toBe(true)
    expect(h.pendingFrames()).toBe(0)
  })

  it('keeps running when a subscriber throws, and unsubscribe works', async () => {
    const h = harness()
    const good = vi.fn()
    h.pipeline.subscribe(() => {
      throw new Error('bad subscriber')
    })
    const off = h.pipeline.subscribe(good)
    await h.pipeline.start(BUILTIN)
    h.frame()
    h.frame()
    expect(good).toHaveBeenCalledTimes(2)
    off()
    h.frame()
    expect(good).toHaveBeenCalledTimes(2)
    expect(h.live.mock).toBe(false)
  })
})

describe('sameSource', () => {
  it('compares camera sources by value', () => {
    expect(sameSource(BUILTIN, { kind: 'builtin' })).toBe(true)
    expect(sameSource(BUILTIN, { kind: 'builtin', deviceId: 'abc' })).toBe(false)
    expect(sameSource(ESP32, { kind: 'mjpeg', url: ESP32.url })).toBe(true)
    expect(sameSource(ESP32, BUILTIN)).toBe(false)
    expect(sameSource(null, BUILTIN)).toBe(false)
  })
})
