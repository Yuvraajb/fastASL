import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraSource, CustomGesture, SignTemplate } from '@shared/types'
import { Timeline, type HandSpec } from '../engine/gestures/synthetic'
import {
  emptyFrames,
  performHolds,
  performSign,
  rng,
  timeline,
  UNKNOWN,
  WORDS,
  type PerformOptions,
  type ShapeName,
  type SignSpec
} from '../engine/recognition/synthetic'
import { staticFeatures } from '../engine/recognition/features'
import { TeachSession } from '../engine/recognition/teach'
import type { FrameSample } from '../engine/types'
import { Controller, QUICK_MENU } from './controller'
import { startEngines, subscribeFrames } from './engines'
import { live } from './live'
import { mockServices, type Services } from './services'
import { getApp, setApp, useApp } from './store'
import type { View } from './types'

const camera = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  setSource: vi.fn(async () => {}),
  setEnabled: vi.fn(async () => {}),
  subscribe: vi.fn((_fn: (frame: FrameSample) => void) => () => {})
}))

vi.mock('../engine/camera/pipeline', () => ({
  CameraPipeline: function CameraPipeline() {
    return camera
  }
}))

const ESP32: CameraSource = { kind: 'mjpeg', url: 'http://192.168.4.1:81/stream' }

let controller: Controller
let stop: (() => void) | null = null

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
})

afterEach(() => {
  stop?.()
  stop = null
  controller.dispose()
  vi.unstubAllGlobals()
})

describe('engines', () => {
  it('starts the camera with the saved settings', () => {
    setApp({ cameraOn: false, cameraSource: ESP32 })
    stop = startEngines(controller)
    expect(camera.setEnabled).toHaveBeenCalledWith(false)
    expect(camera.start).toHaveBeenCalledWith(ESP32)
  })

  it('follows the camera toggle and source changes', () => {
    stop = startEngines(controller)
    setApp({ cameraOn: !getApp().cameraOn })
    expect(camera.setEnabled).toHaveBeenLastCalledWith(false)
    setApp({ cameraSource: ESP32 })
    expect(camera.setSource).toHaveBeenCalledWith(ESP32)
    setApp({ mode: 'spell' })
    expect(camera.setSource).toHaveBeenCalledTimes(1)
    expect(camera.setEnabled).toHaveBeenCalledTimes(2)
  })

  it('stops the camera and ignores the store once stopped', () => {
    startEngines(controller)()
    expect(camera.stop).toHaveBeenCalledTimes(1)
    setApp({ cameraSource: ESP32 })
    expect(camera.setSource).not.toHaveBeenCalled()
  })

  it('fans frames out through the pipeline', () => {
    const fn = vi.fn()
    subscribeFrames(fn)
    expect(camera.subscribe).toHaveBeenCalledWith(fn)
  })
})

/** Synthetic camera frames through the real wiring: pipeline subscriber → GestureEngine → Controller → store. */
describe('gesture control', () => {
  const PALM: HandSpec = { pose: 'openPalm', noise: 0.002 }
  const FIST: HandSpec = { pose: 'fist', noise: 0.002 }
  const TWO: HandSpec = { pose: 'peace', noise: 0.002 }
  const THUMBS_UP: HandSpec = { pose: 'thumbsUp', noise: 0.002 }
  const VGA = { source: {} as CanvasImageSource, sourceWidth: 640, sourceHeight: 480 }

  let tl: Timeline
  let sent = 0

  /** Sends the timeline's frames that were not sent yet to every pipeline subscriber. */
  function play(): void {
    const subscribers = camera.subscribe.mock.calls.map(([fn]) => fn)
    for (const frame of tl.frames.slice(sent)) subscribers.forEach((fn) => fn(frame))
    sent = tl.frames.length
  }

  /** play(), letting the mock services' timers (Claude, the agent) run in step with the frames. */
  async function playTimed(): Promise<void> {
    const subscribers = camera.subscribe.mock.calls.map(([fn]) => fn)
    for (const frame of tl.frames.slice(sent)) {
      subscribers.forEach((fn) => fn(frame))
      await vi.advanceTimersByTimeAsync(1000 / 30)
    }
    sent = tl.frames.length
  }

  /** Two simulated signs, then hands down: the Sentence card. */
  function toSentence(): void {
    for (const text of ['meeting', 'tomorrow']) controller.token({ text, kind: 'word' })
    controller.gesture({ gesture: 'handsDown' })
    expect(getApp().view.kind).toBe('sentence')
  }

  beforeEach(() => {
    Object.assign(live, { ...VGA, mock: false })
    tl = new Timeline({ aspect: 640 / 480 })
    sent = 0
  })

  afterEach(() => {
    Object.assign(live, { source: null, sourceWidth: 0, sourceHeight: 0, mock: true })
    vi.useRealTimers()
  })

  it('collapsed: an open palm held 1 s expands to ready, filling the pill ring on the way', () => {
    setApp({ view: { kind: 'collapsed' } })
    stop = startEngines(controller)
    tl.hold(500, PALM)
    play()
    expect(getApp().view.kind).toBe('collapsed')
    expect(getApp().holdProgress).toBeGreaterThan(0.4)
    expect(getApp().holdProgress).toBeLessThan(0.6)
    tl.hold(600, PALM)
    play()
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().holdProgress).toBe(0)
  })

  it('ready: a held fist collapses the card', () => {
    stop = startEngines(controller)
    tl.hold(700, FIST)
    play()
    expect(getApp().view.kind).toBe('ready')
    tl.hold(400, FIST)
    play()
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('quick menu: 2 fingers held 0.8 s pick option 2, showing progress on its badge', () => {
    stop = startEngines(controller)
    controller.setView({ kind: 'quickMenu', options: QUICK_MENU })
    tl.hold(400, TWO)
    play()
    expect(getApp().pick?.count).toBe(2)
    expect(getApp().pick?.progress).toBeGreaterThan(0.4)
    tl.hold(500, TWO)
    play()
    expect(getApp().view).toEqual({ kind: 'ready', hint: `${QUICK_MENU[1]}: sign the details` })
    expect(getApp().pick).toBeNull()
  })

  it('quick menu: a fist cancels to ready once; keeping it up does not also collapse', () => {
    stop = startEngines(controller)
    controller.setView({ kind: 'quickMenu', options: QUICK_MENU })
    tl.hold(1000, FIST)
    play()
    expect(getApp().view).toEqual({ kind: 'ready' })
    tl.hold(2000, FIST)
    play()
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  // The preview is mirrored: raw +x is toward the left of what the user sees (swipeLeft, previous mode).
  it.each([
    ['toward the user’s right (raw -x): next mode', 0.7, 0.3, 'dictation'],
    ['toward the user’s left (raw +x): previous mode', 0.3, 0.7, 'spell']
  ] as const)('ready: a swipe %s', (_, from, to, mode) => {
    stop = startEngines(controller)
    const hand = { ...PALM, x: from }
    tl.hold(300, hand).move(250, hand, { x: to }).hold(300, { ...hand, x: to })
    play()
    expect(getApp().mode).toBe(mode)
    expect(getApp().view.kind).toBe(mode === 'dictation' ? 'dictation' : 'ready')
  })

  it('in-view gating: a palm held in ready does nothing', () => {
    stop = startEngines(controller)
    tl.hold(2000, PALM)
    play()
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('follows sensitivity changes (low: 1.35 s palm hold)', () => {
    setApp({ view: { kind: 'collapsed' } })
    stop = startEngines(controller)
    setApp({ sensitivity: 'low' })
    tl.hold(1200, PALM)
    play()
    expect(getApp().view.kind).toBe('collapsed')
    tl.hold(300, PALM)
    play()
    expect(getApp().view.kind).toBe('ready')
  })

  it('ignores frames while the feed shows the mock hand and clears the ring', () => {
    setApp({ view: { kind: 'collapsed' } })
    stop = startEngines(controller)
    tl.hold(500, PALM)
    play()
    expect(getApp().holdProgress).toBeGreaterThan(0)
    live.mock = true
    tl.hold(1500, PALM)
    play()
    expect(getApp().view.kind).toBe('collapsed')
    expect(getApp().holdProgress).toBe(0)
  })

  it('starts a new camera session from scratch', () => {
    setApp({ view: { kind: 'collapsed' } })
    stop = startEngines(controller)
    tl.hold(700, PALM)
    play()
    live.source = {} as CanvasImageSource
    tl.hold(700, PALM)
    play()
    expect(getApp().view.kind).toBe('collapsed')
    tl.hold(400, PALM)
    play()
    expect(getApp().view.kind).toBe('ready')
  })

  it('sentence: a thumbs-up kept up through a 100 ms dropout proceeds once and stops at agent ready', async () => {
    vi.useFakeTimers()
    stop = startEngines(controller)
    toSentence()
    tl.hold(1000, THUMBS_UP).none(100).hold(3000, THUMBS_UP)
    await playTimed()
    expect(getApp().view.kind).toBe('agentReady')
  })

  it('agent ready: a thumbs-up kept up through a dropout starts the agent but does not approve its confirm step', async () => {
    vi.useFakeTimers()
    stop = startEngines(controller)
    toSentence()
    controller.gesture({ gesture: 'thumbsUp' })
    await vi.advanceTimersByTimeAsync(600)
    expect(getApp().view.kind).toBe('agentReady')
    tl.hold(1000, THUMBS_UP).none(100).hold(3000, THUMBS_UP)
    await playTimed()
    expect(getApp().view.kind).toBe('confirm')
  })

  it('confirm: a thumbs-up raised before the step appeared has to be made again', async () => {
    vi.useFakeTimers()
    stop = startEngines(controller)
    toSentence()
    controller.gesture({ gesture: 'thumbsUp' })
    await vi.advanceTimersByTimeAsync(600)
    // Start the agent, lower the hand, raise it again while the agent works; the confirm step appears.
    tl.hold(700, THUMBS_UP).none(500).hold(3000, THUMBS_UP)
    await playTimed()
    expect(getApp().view.kind).toBe('confirm')
    tl.none(500).hold(700, THUMBS_UP)
    await playTimed()
    expect(getApp().view.kind).toBe('working')
  })
})

/** Synthetic signers through the real wiring: pipeline subscribers → gesture engine, then RecognitionSession or TeachSession → Controller → store. */
describe('sign recognition', () => {
  const ASPECT = 640 / 480
  const LISTENING: View = { kind: 'recognizing', token: null, isWord: false }

  type Part = (t0: number) => FrameSample[]
  type Extra = Partial<PerformOptions>
  const sign = (spec: SignSpec, seed: number, extra: Extra = {}): Part => (t0) =>
    performSign(spec, { random: rng(seed), aspect: ASPECT, t0, ...extra })
  const hold = (shape: ShapeName, holdMs: number, seed: number, extra: Extra = {}): Part => (t0) =>
    performHolds([{ shape, holdMs }], { random: rng(seed), aspect: ASPECT, t0, ...extra })
  /** No hands in view. A shape already up when recognition starts must change or leave first. */
  const rest: Part = (t0) => emptyFrames(t0, 300)
  const seeds = (n: number, from: number): number[] => Array.from({ length: n }, (_, i) => from + i * 13)

  function teach(label: string, kind: 'word' | 'letter', parts: Part[]): SignTemplate[] {
    const session = new TeachSession(label, kind, parts.length, { aspect: ASPECT })
    for (const frame of timeline(parts)) session.update(frame)
    return session.finish(0)
  }

  const TEMPLATES = [
    ...teach('HELLO', 'word', seeds(5, 1).map((s) => sign(WORDS.HELLO, s))),
    ...teach('PLAY', 'word', seeds(5, 2).map((s) => sign(WORDS.PLAY, s))),
    ...teach('L', 'letter', seeds(5, 3).map((s) => hold('L', 900, s))),
    ...teach('S', 'letter', seeds(5, 4).map((s) => hold('S', 900, s)))
  ]

  let views: View[]
  let stopViews: () => void
  let clock: number

  /** Every view the card showed since the test started. */
  const teachViews = (): Extract<View, { kind: 'settings' }>['settings'][] =>
    views.flatMap((v) => (v.kind === 'settings' && v.settings.page === 'teachRecord' ? [v.settings] : []))

  /** Sends frames to every pipeline subscriber, in subscription order. */
  function send(frames: FrameSample[]): void {
    const subscribers = camera.subscribe.mock.calls.map(([fn]) => fn)
    for (const frame of frames) subscribers.forEach((fn) => fn(frame))
    clock = frames[frames.length - 1].t + 33
  }

  /** Performs the parts, with the hands down for gapMs after each. */
  function play(parts: Part[], gapMs?: number): void {
    send(timeline(parts, gapMs).map((f) => ({ ...f, t: f.t + clock })))
  }

  /** Performs a sign only until `until()` holds: the movement is still in progress. */
  function playUntil(part: Part, until: () => boolean): void {
    for (const frame of part(clock)) {
      send([frame])
      if (until()) return
    }
    throw new Error('the condition never held')
  }

  /** The camera goes away: the pipeline puts the mock hand back, then says the hands are gone. */
  function cameraOff(): void {
    Object.assign(live, { source: null, sourceWidth: 0, sourceHeight: 0, mock: true })
    send([{ t: clock, hands: [] }])
  }

  beforeEach(() => {
    Object.assign(live, { source: {} as CanvasImageSource, sourceWidth: 640, sourceHeight: 480, mock: false })
    setApp({ templates: TEMPLATES })
    views = []
    clock = 0
    stopViews = useApp.subscribe((s, prev) => {
      if (s.view !== prev.view) views.push(s.view)
    })
  })

  afterEach(() => {
    stopViews()
    Object.assign(live, { source: null, sourceWidth: 0, sourceHeight: 0, mock: true })
  })

  it('a known word: Listening, then the word as a lower-case token', () => {
    stop = startEngines(controller)
    play([sign(WORDS.HELLO, 900)])
    expect(views).toEqual([LISTENING, { kind: 'recognizing', token: 'hello', isWord: true }])
  })

  it('a movement that is no sign: Listening, then back to Ready', () => {
    stop = startEngines(controller)
    play([sign(UNKNOWN.reach, 901)])
    expect(views).toEqual([LISTENING, { kind: 'ready' }])
  })

  it('two words, then both hands down: the Sentence', () => {
    stop = startEngines(controller)
    play([sign(WORDS.HELLO, 902), sign(WORDS.PLAY, 903)], 1500)
    expect(getApp().view).toMatchObject({ kind: 'sentence', sentence: 'Hello play' })
  })

  it('the camera going away mid-sign ends Listening', () => {
    stop = startEngines(controller)
    playUntil(sign(WORDS.HELLO, 980), () => views.length > 0)
    expect(getApp().view).toEqual(LISTENING)
    cameraOff()
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('a new camera session mid-sign ends Listening', () => {
    stop = startEngines(controller)
    playUntil(sign(WORDS.HELLO, 981), () => views.length > 0)
    live.source = {} as CanvasImageSource
    send([{ t: clock, hands: [] }])
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('a fist raised into view collapses the card: Listening neither swallows it nor reads an S', () => {
    stop = startEngines(controller)
    play([hold('S', 2500, 904, { raiseMs: 400 })])
    expect(views[0]).toEqual(LISTENING)
    expect(getApp().view).toEqual({ kind: 'collapsed' })
    expect(views.some((v) => v.kind === 'recognizing' && v.token !== null)).toBe(false)
  })

  it('a fist that cancels a phrase is not also an S in the next view', () => {
    stop = startEngines(controller)
    controller.token({ text: 'hello', kind: 'word' })
    play([rest, hold('S', 3000, 930)])
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('Command mode: a held L arrives once a control gesture with that shape would have fired', () => {
    stop = startEngines(controller)
    play([rest, hold('L', 2500, 905)])
    expect(views).toEqual([{ kind: 'recognizing', token: 'L', isWord: false }])
  })

  it('Spell mode: a held letter arrives once', () => {
    setApp({ mode: 'spell' })
    stop = startEngines(controller)
    play([rest, hold('L', 3000, 906)])
    expect(views).toEqual([{ kind: 'recognizing', token: 'L', isWord: false }])
  })

  it('a sign that sweeps a flat hand sideways (MUSIC) is the word, not a swipe', () => {
    setApp({ templates: [...TEMPLATES, ...teach('MUSIC', 'word', seeds(5, 7).map((s) => sign(WORDS.MUSIC, s)))] })
    stop = startEngines(controller)
    play([sign(WORDS.MUSIC, 940)])
    expect(getApp().view).toEqual({ kind: 'recognizing', token: 'music', isWord: true })
    expect(getApp().mode).toBe('command')
    play([sign(WORDS.MUSIC, 941)])
    expect(getApp().view).toMatchObject({ kind: 'building', current: 'music', sentence: 'Music music' })
  })

  it('a word that ends in a thumbs-up (TOMORROW) and stays up does not also end the phrase', () => {
    setApp({ templates: [...TEMPLATES, ...teach('TOMORROW', 'word', seeds(5, 8).map((s) => sign(WORDS.TOMORROW, s)))] })
    stop = startEngines(controller)
    for (const text of ['meeting', 'at']) controller.token({ text, kind: 'word' })
    play([sign(WORDS.TOMORROW, 11, { restAfterMs: 1500 })])
    expect(getApp().view).toMatchObject({ kind: 'building', sentence: 'Meeting at tomorrow' })
  })

  it('a swipe that is no sign still switches the mode, once its movement ends', () => {
    stop = startEngines(controller)
    const palm: HandSpec = { pose: 'openPalm', noise: 0.002, x: 0.7 }
    const swipe: Part = (t0) =>
      new Timeline({ aspect: ASPECT })
        .hold(300, palm)
        .move(250, palm, { x: 0.3 })
        .hold(800, { ...palm, x: 0.3 })
        .frames.map((f) => ({ ...f, t: f.t + t0 }))
    play([swipe])
    expect(getApp().mode).toBe('dictation')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
  })

  it('two signs it cannot tell apart: Did you mean, with lower-case options', () => {
    const reps = seeds(5, 5).map((s) => sign(WORDS.PLAY, s))
    setApp({ templates: [...teach('PLAY', 'word', reps), ...teach('GAME', 'word', reps)] })
    stop = startEngines(controller)
    play([sign(WORDS.PLAY, 960)])
    const view = getApp().view
    expect(view).toMatchObject({ kind: 'didYouMean', purpose: 'sign' })
    expect(view.kind === 'didYouMean' && [...view.options].sort()).toEqual(['game', 'play'])
  })

  it('two letters it cannot tell apart: the best guess, without asking', () => {
    const holds = seeds(5, 6).map((s) => hold('L', 900, s))
    setApp({ mode: 'spell', templates: [...teach('L', 'letter', holds), ...teach('K', 'letter', holds)] })
    stop = startEngines(controller)
    play([rest, hold('L', 1500, 961)])
    const view = getApp().view
    expect(view).toMatchObject({ kind: 'recognizing', isWord: false })
    expect(['K', 'L']).toContain(view.kind === 'recognizing' && view.token)
  })

  it('Dictation: two signs it cannot tell apart type the best guess', () => {
    const reps = seeds(5, 5).map((s) => sign(WORDS.PLAY, s))
    setApp({ mode: 'dictation', templates: [...teach('PLAY', 'word', reps), ...teach('GAME', 'word', reps)] })
    controller.setView({ kind: 'dictation', text: '' })
    stop = startEngines(controller)
    play([sign(WORDS.PLAY, 962)])
    expect(getApp().view).toEqual({ kind: 'dictation', text: expect.stringMatching(/^(play|game)$/) })
  })

  it('Dictation: signs are typed at the cursor as they are recognized, and lowering the hands ends nothing', () => {
    const typeText = vi.fn(async (_text: string) => ({ ok: true as const, value: undefined }))
    controller.setServices({ ...mockServices(), typeText })
    setApp({ mode: 'dictation' })
    controller.setView({ kind: 'dictation', text: '' })
    stop = startEngines(controller)
    play([sign(WORDS.HELLO, 990), sign(WORDS.PLAY, 991)], 1500)
    play([rest, hold('L', 2500, 992)])
    expect(typeText.mock.calls.map(([text]) => text)).toEqual(['hello', ' play', ' L'])
    expect(getApp().view).toEqual({ kind: 'dictation', text: 'hello play L' })
    expect(views.every((v) => v.kind === 'dictation')).toBe(true)
  })

  it('ignores signs in views that take none', () => {
    const working: View = { kind: 'working', intent: 'x', steps: [] }
    controller.setView(working)
    stop = startEngines(controller)
    play([sign(WORDS.HELLO, 907), hold('L', 1500, 908)])
    expect(getApp().view).toBe(working)
  })

  it('Spell a new word: held letters are added at once', () => {
    controller.setView({ kind: 'settings', settings: { page: 'teachSpell', letters: 'K', canSpell: true } })
    stop = startEngines(controller)
    play([rest, hold('L', 1500, 909)])
    expect(getApp().view).toEqual({ kind: 'settings', settings: { page: 'teachSpell', letters: 'KL', canSpell: true } })
  })

  /** Fingerspelling in one hand: each letter held `holdMs`, the last one `lastMs`. */
  const spell = (letters: string, holdMs: number, lastMs: number, seed: number): Part => (t0) =>
    performHolds(
      [...letters].map((shape, i) => ({ shape: shape as ShapeName, holdMs: i === letters.length - 1 ? lastMs : holdMs })),
      { random: rng(seed), aspect: ASPECT, t0 }
    )

  it('Spell a new word: an S held on as the last letter is not also a fist (back)', () => {
    controller.setView({ kind: 'settings', settings: { page: 'teachSpell', letters: '', canSpell: true } })
    stop = startEngines(controller)
    play([rest, spell('LS', 700, 2500, 970)])
    expect(getApp().view).toEqual({ kind: 'settings', settings: { page: 'teachSpell', letters: 'LS', canSpell: true } })
  })

  it('Spell mode: an S held on as the last letter is not also a fist (cancel)', () => {
    setApp({ mode: 'spell' })
    stop = startEngines(controller)
    play([rest, spell('LSLS', 700, 2500, 971)])
    expect(getApp().view).toMatchObject({ kind: 'building', sentence: 'LSLS' })
  })

  it('Spell mode: lowering the hands offers the letters at once, then the spellings', async () => {
    setApp({ mode: 'spell' })
    stop = startEngines(controller)
    play([rest, spell('LSLS', 700, 700, 972)], 1500)
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
      variant: 'list',
      options: ['LSLS'],
      purpose: 'spell',
      quote: 'LSLS',
      pending: true
    })
    await vi.waitFor(() => expect(getApp().view).toMatchObject({ options: ['LSLS', 'lsls', 'lsls@calhacks.io'] }))
  })

  it('Teach › record a word: listening and progress on the card, then the sign is saved and recognized', async () => {
    setApp({ templates: [] })
    controller.setView({ kind: 'settings', settings: { page: 'teachRecord', label: 'PLAY', kind: 'word', done: 0, total: 3 } })
    stop = startEngines(controller)
    play(seeds(3, 910).map((s) => sign(WORDS.PLAY, s)))
    expect(teachViews().some((p) => p.page === 'teachRecord' && p.listening)).toBe(true)
    expect(teachViews().flatMap((p) => (p.page === 'teachRecord' && p.listening === false ? [p.done] : []))).toEqual([1, 2, 3])
    await vi.waitFor(() => expect(getApp().view).toMatchObject({ kind: 'toast', title: 'Learned PLAY' }))
    expect(window.fastasl.saveTemplates).toHaveBeenCalledTimes(1)
    expect(getApp().templates.map((t) => t.label)).toEqual(['PLAY', 'PLAY', 'PLAY'])

    controller.setView({ kind: 'ready' })
    play([sign(WORDS.PLAY, 950)])
    expect(getApp().view).toEqual({ kind: 'recognizing', token: 'play', isWord: true })
  })

  it('Teach › record: the camera going away mid-repetition ends Listening', () => {
    controller.setView({ kind: 'settings', settings: { page: 'teachRecord', label: 'PLAY', kind: 'word', done: 0, total: 3 } })
    stop = startEngines(controller)
    playUntil(sign(WORDS.PLAY, 982), () => teachViews().some((p) => p.page === 'teachRecord' && p.listening))
    cameraOff()
    expect(getApp().view).toMatchObject({ kind: 'settings', settings: { page: 'teachRecord', done: 0, listening: false } })
  })

  it('Teach › record a letter: the hand still up from the finger pick is not a repetition', async () => {
    setApp({ templates: [] })
    controller.setView({ kind: 'settings', settings: { page: 'teachPick', offset: 24, recorded: {} } })
    stop = startEngines(controller)
    play([rest])
    // The page opens with a hand already up (it picked the letter).
    controller.setView({ kind: 'settings', settings: { page: 'teachRecord', label: 'L', kind: 'letter', done: 0, total: 3 } })
    play([hold('L', 2000, 920)])
    expect(teachViews().every((p) => p.page === 'teachRecord' && p.done === 0)).toBe(true)
    play(seeds(3, 921).map((s) => hold('L', 900, s)))
    await vi.waitFor(() => expect(getApp().view).toMatchObject({ kind: 'toast', title: 'Learned L' }))
  })
})

/** Synthetic camera frames through the real wiring: New gesture records a shape, then the shape runs its shortcut. */
describe('custom gestures', () => {
  const ASPECT = 640 / 480
  const PEACE = { id: 'builtin-peace', name: 'Peace sign', task: 'Take a screenshot', shape: [], builtin: true, createdAt: 0 }
  let file: CustomGesture[]
  let services: Services
  let clock: number

  /** Sends the frames to every pipeline subscriber, letting the controller's timers run in step. */
  async function play(frames: FrameSample[]): Promise<void> {
    const subscribers = camera.subscribe.mock.calls.map(([fn]) => fn)
    for (const frame of frames) {
      const shifted = { ...frame, t: frame.t + clock }
      subscribers.forEach((fn) => fn(shifted))
      await vi.advanceTimersByTimeAsync(1000 / 30)
    }
    clock += frames[frames.length - 1].t + 1000 / 30
  }
  const holdShape = (shape: ShapeName, ms: number, seed: number): FrameSample[] =>
    performHolds([{ shape, holdMs: ms }], { random: rng(seed), aspect: ASPECT })
  const holdPose = (spec: HandSpec, ms: number): FrameSample[] => new Timeline({ aspect: ASPECT, t0: 0 }).hold(ms, spec).frames

  /** Settings › New gesture › 1 (the recent task): the countdown starts. */
  async function newGestureForTask(): Promise<void> {
    controller.openSettings()
    controller.gesture({ gesture: 'fingers', count: 2 })
    await vi.advanceTimersByTimeAsync(0)
    controller.gesture({ gesture: 'fingers', count: 1 })
    expect(getApp().view).toMatchObject({ kind: 'settings', settings: { page: 'newGestureHold', task: 'Open Calculator' } })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    file = [PEACE]
    Object.assign(window.fastasl, {
      getGestures: vi.fn(async () => file),
      saveGestures: vi.fn(async (gestures: CustomGesture[]) => void (file = gestures)),
      getRecentTasks: vi.fn(async () => [{ intent: 'Open Calculator', title: 'Opened Calculator', at: 0, evidence: [] }])
    })
    Object.assign(live, { source: {} as CanvasImageSource, sourceWidth: 640, sourceHeight: 480, mock: false })
    services = mockServices()
    controller.dispose()
    controller = new Controller(services)
    clock = 0
  })

  afterEach(() => {
    Object.assign(live, { source: null, sourceWidth: 0, sourceHeight: 0, mock: true })
    vi.useRealTimers()
  })

  it('records the shape held through the countdown, then the shape held in Ready runs its shortcut', async () => {
    const run = vi.spyOn(services, 'runShortcut')
    stop = startEngines(controller)
    await newGestureForTask()
    await play(holdShape('Y', 4400, 31))
    expect(getApp().view).toMatchObject({ kind: 'toast', title: 'Gesture saved', subtitle: 'Gesture 2 · Open Calculator' })
    const saved = file[1]
    expect(saved).toMatchObject({ name: 'Gesture 2', task: 'Open Calculator' })
    expect(saved.shape).toHaveLength(10)
    expect(getApp().gestures).toEqual(file)

    // Held on through the toast and My gestures, the shape runs nothing: shapes act in Ready and Collapsed only.
    await play(holdShape('Y', 3000, 32))
    expect(getApp().view).toMatchObject({ kind: 'settings', settings: { page: 'gestures' } })
    expect(run).not.toHaveBeenCalled()

    controller.expand()
    await play([...emptyFrames(0, 300), ...holdShape('Y', 1200, 33).map((f) => ({ ...f, t: f.t + 300 }))])
    expect(run).toHaveBeenCalledWith(saved.id)
    await vi.advanceTimersByTimeAsync(400) // the mock shortcut's run
    expect(getApp().view).toMatchObject({ kind: 'toast', title: 'Playing Motion Sickness', returnTo: 'ready' })
  })

  it('a fist is refused with the reason, and the fist still up neither retries nor goes back', async () => {
    stop = startEngines(controller)
    await newGestureForTask()
    await play(holdPose({ pose: 'fist', noise: 0.002 }, 6500))
    expect(getApp().view).toMatchObject({
      kind: 'settings',
      settings: { page: 'newGestureHold', reason: 'That reads as a fist, a control gesture. Try another shape.' }
    })
    expect(file).toEqual([PEACE])
    // A fresh thumbs up records again.
    await play([...emptyFrames(0, 400), ...holdPose({ pose: 'thumbsUp', noise: 0.002 }, 700).map((f) => ({ ...f, t: f.t + 400 }))])
    expect(getApp().view).toMatchObject({ kind: 'settings', settings: { page: 'newGestureHold', countdown: 3 } })
    expect(getApp().view).not.toHaveProperty('settings.reason')
  })

  it('a hand-edited gesture without a shape breaks neither loading, My gestures nor a recording', async () => {
    file = [PEACE, { id: 'g3', name: 'Gesture 3', task: 'Open Notes', createdAt: 1 } as unknown as CustomGesture]
    stop = startEngines(controller)
    await expect(controller.loadGestures()).resolves.toHaveLength(2)
    controller.openSettings()
    controller.gesture({ gesture: 'fingers', count: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(getApp().view).toMatchObject({ kind: 'settings', settings: { page: 'gestures' } })
    await newGestureForTask()
    await play(holdShape('Y', 4400, 31))
    expect(getApp().view).toMatchObject({ kind: 'toast', title: 'Gesture saved', subtitle: 'Gesture 2 · Open Calculator' })
  })

  it('a shape that reads as a taught letter is refused, so it can never swallow that letter', async () => {
    const letter = (seed: number, i: number): SignTemplate => ({
      id: `y${i}`,
      label: 'Y',
      kind: 'letter',
      frames: [staticFeatures(holdShape('Y', 1000, seed)[15].hands[0], ASPECT)!],
      createdAt: 0
    })
    setApp({ templates: [40, 41, 42, 43, 44].map(letter) })
    stop = startEngines(controller)
    await newGestureForTask()
    await play(holdShape('Y', 4400, 31))
    expect(getApp().view).toMatchObject({
      kind: 'settings',
      settings: { page: 'newGestureHold', reason: 'That reads as the letter Y. Try another shape.' }
    })
    expect(file).toEqual([PEACE])
  })

  it('the mock hand is never recorded: the recording times out', async () => {
    stop = startEngines(controller)
    await newGestureForTask()
    live.mock = true
    await play(holdShape('Y', 6000, 34))
    expect(getApp().view).toMatchObject({ kind: 'settings', settings: { page: 'newGestureHold', reason: 'No hand seen. Hold one hand up in view.' } })
  })
})
