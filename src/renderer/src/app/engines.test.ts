import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraSource } from '@shared/types'
import { Timeline, type HandSpec } from '../engine/gestures/synthetic'
import type { FrameSample } from '../engine/types'
import { Controller, QUICK_MENU } from './controller'
import { startEngines, subscribeFrames } from './engines'
import { live } from './live'
import { mockServices } from './services'
import { getApp, setApp, useApp } from './store'

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
    fastasl: { isDev: false, saveSettings: vi.fn(async () => ({})), getGestures: vi.fn(async () => []) }
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
