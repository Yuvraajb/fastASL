/**
 * The pretrained sign model in the real wiring: pipeline subscribers → gesture engine →
 * recognition (model first, taught signs second, then an LLM guess) → Controller → store.
 * Most tests use a fake model so the outcome is exact; the last ones run the real Kaggle model
 * (onnxruntime-web in Node) on synthetic control gestures, which it must not swallow.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SignTemplate } from '@shared/types'
import { Timeline, type HandSpec } from '../engine/gestures/synthetic'
import { describeTop, type ModelDecision } from '../engine/model/decide'
import { ortSession } from '../engine/model/runtime'
import { SignModel, type ModelVerdict, type MovementWindow } from '../engine/model/signModel'
import { knownSigns } from '../engine/model/vocabulary'
import { emptyFrames, performHolds, performSign, rng, syntheticFace, timeline, WORDS, UNKNOWN, type PerformOptions, type ShapeName, type SignSpec } from '../engine/recognition/synthetic'
import { TeachSession } from '../engine/recognition/teach'
import type { FrameSample } from '../engine/types'
import { Controller } from './controller'
import { startEngines } from './engines'
import { live } from './live'
import { MODEL_WAIT_MS } from './recognitionInput'
import { mockServices } from './services'
import { getApp, setApp, useApp } from './store'
import type { View } from './types'

const camera = vi.hoisted(() => ({
  setExtras: vi.fn(),
  takeTimings: vi.fn(async () => null),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  setSource: vi.fn(async () => {}),
  setEnabled: vi.fn(async () => {}),
  subscribe: vi.fn((_fn: (frame: FrameSample) => void) => () => {}),
  onStatus: vi.fn((_fn: (error: string | null) => void) => () => {})
}))

vi.mock('../engine/camera/pipeline', () => ({
  CameraPipeline: function CameraPipeline() {
    return camera
  }
}))

const loader = vi.hoisted(() => ({ load: vi.fn() }))

vi.mock('../engine/model/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/model/runtime')>()),
  loadSignModel: (...args: unknown[]) => loader.load(...args)
}))

const ASPECT = 640 / 480
type Part = (t0: number) => FrameSample[]
type Extra = Partial<PerformOptions>
const sign = (spec: SignSpec, seed: number, extra: Extra = {}): Part => (t0) => performSign(spec, { random: rng(seed), aspect: ASPECT, t0, ...extra })
const hold = (shape: ShapeName, holdMs: number, seed: number, extra: Extra = {}): Part => (t0) =>
  performHolds([{ shape, holdMs }], { random: rng(seed), aspect: ASPECT, t0, ...extra })
const rest: Part = (t0) => emptyFrames(t0, 300)
const seeds = (n: number, from: number): number[] => Array.from({ length: n }, (_, i) => from + i * 13)
const PALM: HandSpec = { pose: 'openPalm', noise: 0.002, x: 0.7 }
/** An open palm swept toward the user's right: swipeRight, the next mode. */
const swipe: Part = (t0) =>
  new Timeline({ aspect: ASPECT })
    .hold(300, PALM)
    .move(250, PALM, { x: 0.3 })
    .hold(800, { ...PALM, x: 0.3 })
    .frames.map((f) => ({ ...f, t: f.t + t0 }))

function teach(label: string, parts: Part[]): SignTemplate[] {
  const session = new TeachSession(label, 'word', parts.length, { aspect: ASPECT })
  for (const frame of timeline(parts)) session.update(frame)
  return session.finish(0)
}
const HELLO_TAUGHT = teach('HELLO', seeds(5, 1).map((s) => sign(WORDS.HELLO, s)))

/** A model that answers `decision` for every movement (or never, for `null`). */
function fakeModel(decision: ModelDecision | null): SignModel & { classify: ReturnType<typeof vi.fn> } {
  const classify = vi.fn(async (w: MovementWindow): Promise<ModelVerdict> => {
    if (!decision) return new Promise(() => {})
    const top = decision.status === 'accepted' ? [{ word: decision.word, p: decision.p, rank: 0 }] : []
    return { decision, islr: { ranked: top, swapped: false, ms: 1 }, citizen: null, face: false, pose: false, frames: w.frames.length, ms: 1 }
  })
  return { words: ['hello', 'thank you', 'yes', 'no', 'tomorrow'], hasCitizen: false, classify } as unknown as SignModel & { classify: ReturnType<typeof vi.fn> }
}

let controller: Controller
let stop: (() => void) | null = null
let views: View[]
let stopViews: () => void
let clock: number

/** Lets promises (the model's answer) settle, as they would between two camera frames. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** Each frame to every pipeline subscriber, in subscription order, with a pause between frames. */
async function play(parts: Part[], gapMs?: number): Promise<void> {
  const subscribers = camera.subscribe.mock.calls.map(([fn]) => fn)
  const frames = timeline(parts, gapMs).map((f) => ({ ...f, t: f.t + clock }))
  for (const frame of frames) {
    subscribers.forEach((fn) => fn(frame))
    await settle()
  }
  clock = frames[frames.length - 1].t + 33
}

async function start(model: SignModel | null): Promise<void> {
  loader.load.mockImplementation(async () => {
    if (!model) throw new Error('no model in this test')
    return model
  })
  stop = startEngines(controller)
  await settle()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    fastasl: {
      isDev: false,
      saveSettings: vi.fn(async () => ({})),
      getGestures: vi.fn(async () => []),
      getTemplates: vi.fn(async () => ({ version: 1, templates: getApp().templates })),
      saveTemplates: vi.fn(async () => {})
    }
  })
  useApp.setState(useApp.getInitialState(), true)
  controller = new Controller(mockServices())
  Object.assign(live, { source: {} as CanvasImageSource, sourceWidth: 640, sourceHeight: 480, mock: false })
  views = []
  clock = 0
  stopViews = useApp.subscribe((s, prev) => {
    if (s.view !== prev.view) views.push(s.view)
  })
})

afterEach(() => {
  stop?.()
  stop = null
  stopViews()
  controller.dispose()
  Object.assign(live, { source: null, sourceWidth: 0, sourceHeight: 0, mock: true })
  vi.unstubAllGlobals()
})

describe('recognition order: the pretrained model, then taught signs, then an LLM guess', () => {
  it('once loaded, the camera tracks the face and the LLM is told the model’s words', async () => {
    await start(fakeModel({ status: 'rejected' }))
    expect(camera.setExtras).toHaveBeenCalledWith({ face: true, pose: false })
    expect(getApp().modelWords).toEqual(knownSigns(false))
  })

  it('a sign nobody taught that the model knows becomes its word at once, and nothing is asked', async () => {
    const model = fakeModel({ status: 'accepted', word: 'thank you', p: 0.95 })
    const unknown = vi.spyOn(controller, 'unknownSign')
    await start(model)
    await play([sign(UNKNOWN.reach, 2001, { restAfterMs: 2500 })])
    expect(model.classify).toHaveBeenCalledTimes(1)
    // The model sees the movement and the frames around it.
    const [window] = model.classify.mock.calls[0] as [MovementWindow]
    expect(window.start).toBeGreaterThan(0)
    expect(window.end).toBeLessThan(window.frames.length - 1)
    expect(views).toEqual([{ kind: 'recognizing', token: 'thank you', isWord: true }])
    expect(unknown).not.toHaveBeenCalled()
  })

  it('a streaming sign comes first: its movement goes to neither the model nor the LLM', async () => {
    const identify = vi.fn(async () => ({ ok: true as const, value: { is_sign: false, candidates: [] } }))
    controller.setServices({ ...mockServices(), identifySign: identify, signGuessUnavailable: () => null, sendsFrames: () => true })
    // A model that would name any movement it saw.
    const model = fakeModel({ status: 'accepted', word: 'thank you', p: 0.95 })
    await start(model)
    const face = syntheticFace({ cx: 0.5, cy: 0.38, w: 0.16, h: 0.3 })
    const hello: Part = (t0) => performSign(WORDS.HELLO, { random: rng(2010), aspect: ASPECT, t0, center: [0.5, 0.35], restBeforeMs: 400, restAfterMs: 2500 }).map((f) => ({ ...f, face }))
    await play([hello])
    expect(views).toEqual([{ kind: 'recognizing', token: 'hello', isWord: true }])
    expect(model.classify).not.toHaveBeenCalled()
    expect(identify).not.toHaveBeenCalled()
  })

  it('the model unsure, a taught sign still matches: the taught word', async () => {
    setApp({ templates: HELLO_TAUGHT })
    await start(fakeModel({ status: 'rejected' }))
    await play([sign(WORDS.HELLO, 2002)])
    expect(views).toEqual([{ kind: 'recognizing', token: 'hello', isWord: true }])
  })

  it('neither knows the movement: it goes to the LLM guess as before, with the model’s words as known signs', async () => {
    const identify = vi.fn(async () => ({ ok: true as const, value: { is_sign: false, candidates: [] } }))
    controller.setServices({ ...mockServices(), identifySign: identify, signGuessUnavailable: () => null, sendsFrames: () => true })
    await start(fakeModel({ status: 'rejected' }))
    await play([sign(UNKNOWN.reach, 2003, { restAfterMs: 2500 })])
    expect(identify).toHaveBeenCalledTimes(1)
    const [req] = identify.mock.calls[0] as unknown as [{ known: string[] }]
    expect(req.known).toEqual(expect.arrayContaining(['HELLO', 'THANK YOU', 'CALL', 'EAT']))
  })

  it('a close call becomes "Did you mean" between the model’s two words', async () => {
    await start(fakeModel({ status: 'ambiguous', options: ['yes', 'no'] }))
    await play([sign(UNKNOWN.reach, 2004)])
    expect(getApp().view).toMatchObject({ kind: 'didYouMean', purpose: 'sign', options: ['yes', 'no'] })
  })

  it('a model that never answers holds the movement only MODEL_WAIT_MS: then the taught word', async () => {
    setApp({ templates: HELLO_TAUGHT })
    await start(fakeModel(null))
    await play([sign(WORDS.HELLO, 2005, { restAfterMs: MODEL_WAIT_MS + 300 })])
    expect(views).toEqual([{ kind: 'recognizing', token: 'hello', isWord: true }])
  })

  it('letters are unchanged: a held L arrives, and Spell mode never asks the model', async () => {
    setApp({ templates: teachLetter('L') })
    const model = fakeModel({ status: 'rejected' })
    await start(model)
    await play([rest, hold('L', 2500, 2006)])
    expect(views).toContainEqual({ kind: 'recognizing', token: 'L', isWord: false })
    setApp({ mode: 'spell' })
    model.classify.mockClear()
    await play([sign(UNKNOWN.reach, 2007), rest, hold('L', 2500, 2008)])
    expect(model.classify).not.toHaveBeenCalled()
  })
})

describe('control gestures are not swallowed by model words', () => {
  it('a swipe the model reads as a word it is not very sure of (0.85) still switches the mode', async () => {
    await start(fakeModel({ status: 'accepted', word: 'hello', p: 0.85 }))
    await play([swipe])
    expect(getApp().mode).toBe('dictation')
    expect(views.some((v) => v.kind === 'recognizing')).toBe(false)
  })

  it('a movement the model is very sure of (0.97) is the word even though it swept like a swipe (as a taught MUSIC is)', async () => {
    await start(fakeModel({ status: 'accepted', word: 'hello', p: 0.97 }))
    await play([swipe])
    expect(getApp().mode).toBe('command')
    expect(getApp().view).toEqual({ kind: 'recognizing', token: 'hello', isWord: true })
  })

  it('a fist raised into view collapses the card though the model reads the raise as YES at 0.85', async () => {
    await start(fakeModel({ status: 'accepted', word: 'yes', p: 0.85 }))
    await play([hold('S', 2500, 2009, { raiseMs: 400 })])
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('a word that ends in a thumbs-up the model is sure of (TOMORROW, 0.95) does not also end the phrase', async () => {
    await start(fakeModel({ status: 'accepted', word: 'tomorrow', p: 0.95 }))
    for (const text of ['meeting', 'at']) controller.token({ text, kind: 'word' })
    await play([sign(WORDS.TOMORROW, 11, { restAfterMs: 1500 })])
    expect(getApp().view).toMatchObject({ kind: 'building', sentence: 'Meeting at tomorrow' })
  })

  it.each([
    ['a sure word (0.95) wins, and the thumbs-up held with it does not also end the phrase', { status: 'accepted', word: 'tomorrow', p: 0.95 } as const, 'building'],
    ['no word: the thumbs-up acts once the model has answered (it sends the phrase)', { status: 'rejected' } as const, 'conversation']
  ])('a thumbs-up that fires while the model is still judging waits for its answer: %s', async (_case, decision, kind) => {
    let answer!: (d: ModelDecision) => void
    const model = fakeModel(null)
    model.classify.mockImplementation(
      (w: MovementWindow) =>
        new Promise<ModelVerdict>((resolve) => {
          answer = (d) => resolve({ decision: d, islr: null, citizen: null, face: false, pose: false, frames: w.frames.length, ms: 400 })
        })
    )
    await start(model)
    for (const text of ['meeting', 'at']) controller.token({ text, kind: 'word' })
    // The thumbs-up hold fires ~0.1 s after the movement ends, well within MODEL_WAIT_MS.
    await play([sign(WORDS.TOMORROW, 11, { restAfterMs: 700 })])
    expect(model.classify).toHaveBeenCalledTimes(1)
    expect(getApp().view.kind).toBe('building')
    answer(decision)
    await play([hold('A', 300, 2012)])
    expect(getApp().view.kind).toBe(kind)
    if (kind === 'building') expect(getApp().view).toMatchObject({ sentence: 'Meeting at tomorrow' })
  })

  it('Show me a sign: the model names it at once, with no LLM call', async () => {
    const identify = vi.fn()
    controller.setServices({ ...mockServices(), identifySign: identify, signGuessUnavailable: () => null, sendsFrames: () => true })
    await start(fakeModel({ status: 'accepted', word: 'thank you', p: 0.95 }))
    controller.setView({ kind: 'settings', settings: { page: 'teachShow', phase: 'waiting' } })
    await play([rest, sign(UNKNOWN.reach, 2010, { restAfterMs: 600 })], 1200)
    await vi.waitFor(() => expect(getApp().view).toEqual({ kind: 'settings', settings: { page: 'teachShow', phase: 'guess', guesses: ['THANK YOU'] } }))
    expect(identify).not.toHaveBeenCalled()
  })
})

function teachLetter(label: ShapeName): SignTemplate[] {
  const session = new TeachSession(label, 'letter', 5, { aspect: ASPECT })
  for (const frame of timeline(seeds(5, 3).map((s) => hold(label, 900, s)))) session.update(frame)
  return session.finish(0)
}

const ISLR = resolve('src/renderer/public/models/islr1st.onnx')

describe.skipIf(!existsSync(ISLR))('the real Kaggle model on synthetic control gestures', () => {
  async function realModel(): Promise<SignModel> {
    const ort = await import('onnxruntime-web/wasm')
    ort.env.wasm.numThreads = 1
    return new SignModel({ islr: await ortSession(ort, readFileSync(ISLR)) })
  }

  /** play(), giving the model's real (wasm) inference time to answer between frames. */
  async function playSlowly(parts: Part[]): Promise<void> {
    const subscribers = camera.subscribe.mock.calls.map(([fn]) => fn)
    const frames = timeline(parts).map((f) => ({ ...f, t: f.t + clock }))
    for (const frame of frames) {
      subscribers.forEach((fn) => fn(frame))
      await new Promise((r) => setTimeout(r, 2))
    }
    clock = frames[frames.length - 1].t + 33
  }

  it('a swipe still switches the mode, and a raised fist still collapses the card', async () => {
    const model = await realModel()
    const classify = vi.spyOn(model, 'classify')
    await start(model)
    await playSlowly([swipe])
    expect(getApp().mode).toBe('dictation')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    // Back to Command, then a fist raised into view and held.
    setApp({ mode: 'command' })
    controller.setView({ kind: 'ready' })
    await playSlowly([rest, hold('S', 2500, 2011, { raiseMs: 400 })])
    expect(getApp().view).toEqual({ kind: 'collapsed' })
    expect(classify).toHaveBeenCalled()
    for (const result of classify.mock.results) {
      const v = await (result.value as Promise<ModelVerdict>)
      console.log(`[model] synthetic gesture: ${v.islr ? describeTop(v.islr.ranked) : 'no hands'} (rank ${v.islr?.ranked[0]?.rank}) -> ${v.decision.status}`)
    }
  }, 60_000)
})
