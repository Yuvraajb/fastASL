import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision'
import { createHandTracker, MissingAssetsError, toFrameSample } from './handTracker'

const mp = vi.hoisted(() => ({
  forVisionTasks: vi.fn(async (base: string) => ({
    wasmLoaderPath: `${base}/vision_wasm_internal.js`,
    wasmBinaryPath: `${base}/vision_wasm_internal.wasm`
  })),
  createFromOptions: vi.fn()
}))

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: mp.forVisionTasks },
  HandLandmarker: { createFromOptions: mp.createFromOptions }
}))

const EMPTY: HandLandmarkerResult = { landmarks: [], worldLandmarks: [], handedness: [], handednesses: [] }

function fakeLandmarker(detect: (frame: unknown, t: number) => HandLandmarkerResult = () => EMPTY) {
  return { detectForVideo: vi.fn(detect), close: vi.fn() }
}

const element = {} as HTMLCanvasElement

/** fetch() for the asset check: every file present, except `missing` (rejects, like file://) and `html` (the dev server's fallback page). */
function stubAssets({ missing = [], html = [] }: { missing?: string[]; html?: string[] } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (missing.some((name) => url.endsWith(name))) throw new TypeError('Failed to fetch')
    const type = html.some((name) => url.endsWith(name)) ? 'text/html' : 'application/octet-stream'
    return new Response('bytes', { headers: { 'content-type': type } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('createHandTracker', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { href: 'http://localhost:5173/?stage=1' })
    vi.stubGlobal('ImageData', class {
      constructor(
        public width: number,
        public height: number
      ) {}
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stubAssets()
    mp.createFromOptions.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads the bundled wasm and model next to the page, GPU first, in VIDEO mode', async () => {
    mp.createFromOptions.mockResolvedValue(fakeLandmarker())
    const tracker = await createHandTracker()
    expect(tracker.delegate).toBe('GPU')
    expect(mp.forVisionTasks).toHaveBeenCalledWith('http://localhost:5173/mediapipe/wasm')
    const [, options] = mp.createFromOptions.mock.calls[0]
    expect(options).toMatchObject({
      baseOptions: { modelAssetPath: 'http://localhost:5173/mediapipe/hand_landmarker.task', delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2
    })
  })

  it('resolves assets next to a packaged file:// page', async () => {
    vi.stubGlobal('location', { href: 'file:///Applications/fastASL.app/Contents/Resources/app.asar/out/renderer/index.html' })
    mp.createFromOptions.mockResolvedValue(fakeLandmarker())
    await createHandTracker()
    expect(mp.forVisionTasks).toHaveBeenLastCalledWith(
      'file:///Applications/fastASL.app/Contents/Resources/app.asar/out/renderer/mediapipe/wasm'
    )
  })

  it('checks that the wasm runtime and the model are there before loading', async () => {
    const fetchMock = stubAssets()
    mp.createFromOptions.mockResolvedValue(fakeLandmarker())
    await createHandTracker()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:5173/mediapipe/wasm/vision_wasm_internal.js',
      'http://localhost:5173/mediapipe/wasm/vision_wasm_internal.wasm',
      'http://localhost:5173/mediapipe/hand_landmarker.task'
    ])
  })

  it.each([
    ['a file is missing', { missing: ['hand_landmarker.task'] }],
    ['the dev server answers with its HTML fallback', { html: ['vision_wasm_internal.js'] }]
  ])('reports missing MediaPipe files when %s, without trying to load them', async (_case, assets) => {
    stubAssets(assets)
    const loading = createHandTracker()
    await expect(loading).rejects.toBeInstanceOf(MissingAssetsError)
    await expect(loading).rejects.toThrow('Hand tracking files are missing — run npm run setup')
    expect(mp.createFromOptions).not.toHaveBeenCalled()
  })

  it('turns a script load Event into a readable error', async () => {
    mp.createFromOptions.mockRejectedValue(new Event('error'))
    await expect(createHandTracker()).rejects.toThrow('the MediaPipe runtime script failed to load')
  })

  it('falls back to CPU when the GPU delegate cannot be created', async () => {
    mp.createFromOptions.mockRejectedValueOnce(new Error('WebGL unavailable')).mockResolvedValueOnce(fakeLandmarker())
    const tracker = await createHandTracker()
    expect(tracker.delegate).toBe('CPU')
    expect(mp.createFromOptions.mock.calls[1][1].baseOptions.delegate).toBe('CPU')
  })

  it('falls back to CPU when the GPU warm-up inference fails', async () => {
    const gpu = fakeLandmarker(() => {
      throw new Error('texImage2D failed')
    })
    mp.createFromOptions.mockResolvedValueOnce(gpu).mockResolvedValueOnce(fakeLandmarker())
    const tracker = await createHandTracker()
    expect(gpu.close).toHaveBeenCalled()
    expect(tracker.delegate).toBe('CPU')
  })

  it('forces strictly increasing timestamps', async () => {
    const landmarker = fakeLandmarker()
    mp.createFromOptions.mockResolvedValue(landmarker)
    const tracker = await createHandTracker()
    const times = [100, 100, 50, 250.5].map((t) => tracker.detect(element, t).t)
    expect(times).toEqual([100, 101, 102, 250.5])
    const sent = landmarker.detectForVideo.mock.calls.map(([, t]) => t)
    expect(sent).toEqual([0, 100, 101, 102, 250.5])
  })
})

describe('toFrameSample', () => {
  it('maps MediaPipe results to hand samples', () => {
    const pts = (x: number) => Array.from({ length: 21 }, (_, i) => ({ x, y: i / 21, z: -0.01, visibility: 0 }))
    const result: HandLandmarkerResult = {
      landmarks: [pts(0.2), pts(0.7)],
      worldLandmarks: [],
      handedness: [
        [{ categoryName: 'Left', displayName: 'Left', score: 0.98, index: 1 }],
        [{ categoryName: 'Right', displayName: 'Right', score: 0.91, index: 0 }]
      ],
      handednesses: []
    }
    const frame = toFrameSample(result, 1234)
    expect(frame.t).toBe(1234)
    expect(frame.hands.map((h) => [h.handedness, h.score])).toEqual([
      ['Left', 0.98],
      ['Right', 0.91]
    ])
    expect(frame.hands[0].landmarks).toHaveLength(21)
    expect(frame.hands[0].landmarks[3]).toEqual({ x: 0.2, y: 3 / 21, z: -0.01 })
  })

  it('returns no hands for an empty result', () => {
    expect(toFrameSample(EMPTY, 5)).toEqual({ t: 5, hands: [] })
  })
})
