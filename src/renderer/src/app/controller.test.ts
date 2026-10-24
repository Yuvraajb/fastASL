import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  CompletedTask,
  CustomGesture,
  IntentResult,
  Settings,
  ShortcutRunResult,
  SignTemplate,
  TemplateStore
} from '@shared/types'
import {
  Controller,
  QUICK_MENU,
  SETTINGS_ROOT,
  activeGestures,
  assembleSentence,
  dictationChunk,
  gestureScreen,
  isCapturingShape,
  nextGestureName,
  optionsFor,
  takesSigns,
  type GestureName
} from './controller'
import { CAPTURE_REASONS } from '../engine/gestures/customShapes'
import { live } from './live'
import { mockServices, type Services } from './services'
import { getApp, setApp, useApp } from './store'
import type { SettingsPage, Token, View } from './types'

// Mirrors the controller's private timings.
const TOAST_MS = 2600
const DONE_AUTO_COLLAPSE_MS = 4000
const TYPED_RUN_MS = 2 * 60_000

const word = (text: string): Token => ({ text, kind: 'word' })
const letter = (text: string): Token => ({ text, kind: 'letter' })
const MEETING = ['meeting', 'tomorrow', 'at', '3', 'pm'].map(word)

const STREAM = 'http://192.168.1.50:81/stream'
const SETTINGS: Settings = {
  cameraSource: { kind: 'mjpeg', url: STREAM },
  cameraEnabled: true,
  sensitivity: 'medium',
  mode: 'command',
  streamUrl: STREAM
}
const GESTURES: CustomGesture[] = [
  { id: 'builtin-peace', name: 'Peace sign', task: 'Take a screenshot', shape: [], builtin: true, createdAt: 0 },
  { id: 'g2', name: 'Rock on', task: 'Play Motion Sickness', shape: [], createdAt: 1 }
]
const RECENT: CompletedTask[] = [{ intent: 'Open Notes', title: 'Notes opened', at: 0, evidence: [] }]

/** The slice of window.fastasl the controller touches. */
function stubWindow() {
  const api = {
    saveSettings: vi.fn(async (patch: Partial<Settings>) => ({ ...SETTINGS, ...patch })),
    getSettings: vi.fn(async () => SETTINGS),
    getGestures: vi.fn(async () => GESTURES),
    saveGestures: vi.fn(async (_gestures: CustomGesture[]) => {}),
    getRecentTasks: vi.fn(async () => RECENT),
    getTemplates: vi.fn(async (): Promise<TemplateStore> => ({ version: 1, templates: [] })),
    saveTemplates: vi.fn(async (_store: TemplateStore) => {})
  }
  vi.stubGlobal('window', { fastasl: api })
  return api
}

function intentResult(patch: Partial<IntentResult>): IntentResult {
  return {
    sentence: 'Here is the update',
    intent: null,
    alternatives: [],
    confidence: 0.9,
    needs_confirmation: false,
    context_actions: [],
    ...patch
  }
}

/** Agent services whose events the test emits by hand. */
function manualAgent(base: Services) {
  const listeners = new Set<(e: AgentEvent) => void>()
  const services: Services = {
    ...base,
    onAgentEvent: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    agentRun: vi.fn(async () => ({ ok: true as const, value: { runId: 'r1' } })),
    agentStop: vi.fn(async () => {}),
    agentRespond: vi.fn(async () => {})
  }
  return { services, emit: (e: AgentEvent) => listeners.forEach((l) => l(e)) }
}

let api: ReturnType<typeof stubWindow>
let services: Services
let c: Controller

/** Current view, asserted to be of `kind`. */
function viewAs<K extends View['kind']>(kind: K): Extract<View, { kind: K }> {
  const view = getApp().view
  expect(view.kind).toBe(kind)
  return view as Extract<View, { kind: K }>
}

/** Advance fake time and let every pending promise chain settle. */
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

const g = (gesture: GestureName): void => c.gesture({ gesture })
const fingers = (count: number): void => c.gesture({ gesture: 'fingers', count })
const sign = (...tokens: Token[]): void => tokens.forEach((t) => c.token(t))

function signSentence(...tokens: Token[]): Extract<View, { kind: 'sentence' }> {
  sign(...tokens)
  g('handsDown')
  return viewAs('sentence')
}

async function toAgentReady(): Promise<Extract<View, { kind: 'agentReady' }>> {
  signSentence(...MEETING)
  g('thumbsUp')
  await settle(500)
  return viewAs('agentReady')
}

function useServices(next: Services): void {
  c.dispose()
  services = next
  c = new Controller(next)
}

beforeEach(() => {
  vi.useFakeTimers()
  useApp.setState(useApp.getInitialState(), true)
  api = stubWindow()
  services = mockServices()
  c = new Controller(services)
})

afterEach(() => {
  c.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe('assembleSentence', () => {
  it('is empty for no tokens', () => {
    expect(assembleSentence([])).toBe('')
  })

  it('joins words and capitalizes the first letter', () => {
    expect(assembleSentence(MEETING)).toBe('Meeting tomorrow at 3 pm')
  })

  it('merges consecutive letters into one word', () => {
    expect(assembleSentence([letter('A'), letter('M'), letter('C')])).toBe('AMC')
    expect(assembleSentence([word('call'), letter('K'), letter('C'), word('now')])).toBe('Call KC now')
  })

  it('keeps separate letter runs apart when a word sits between them', () => {
    expect(assembleSentence([letter('a'), letter('b'), word('and'), letter('c'), letter('d')])).toBe('Ab and cd')
  })
})

describe('gesture gating', () => {
  it('ignores finger counts in ready', () => {
    const ready = getApp().view
    fingers(2)
    expect(getApp().view).toBe(ready)
  })

  it('accepts only palmHold (and shapes) while collapsed', () => {
    c.collapse()
    for (const gesture of ['thumbsUp', 'fist', 'swipeLeft', 'swipeRight', 'swipeUp', 'handsDown'] as const) {
      g(gesture)
      expect(getApp().view.kind).toBe('collapsed')
    }
    fingers(1)
    expect(getApp().view.kind).toBe('collapsed')
  })

  it('ignores palmHold everywhere except the collapsed pill', () => {
    const views: View[] = [
      { kind: 'ready' },
      { kind: 'building', tokens: [word('hi')], current: 'hi', sentence: 'Hi' },
      { kind: 'settings', settings: { page: 'root' } },
      { kind: 'dictation', text: '' }
    ]
    for (const view of views) {
      c.setView(view)
      g('palmHold')
      expect(getApp().view).toBe(view)
    }
  })

  it('lets only a fist through while the agent works', () => {
    const working: View = { kind: 'working', intent: 'x', steps: [] }
    c.setView(working)
    g('thumbsUp')
    g('swipeLeft')
    fingers(1)
    expect(getApp().view).toBe(working)
  })

  it('exposes the per-view gesture sets', () => {
    expect(activeGestures({ kind: 'collapsed' })).toEqual(new Set(['palmHold', 'shape']))
    expect(activeGestures({ kind: 'ready' }).has('fingers')).toBe(false)
    expect(activeGestures({ kind: 'quickMenu', options: [] }).has('fingers')).toBe(true)
    const list: View = { kind: 'didYouMean', variant: 'list', options: [], purpose: 'intent' }
    const quote: View = { kind: 'didYouMean', variant: 'quote', options: [], purpose: 'intent' }
    const signs: View = { kind: 'didYouMean', variant: 'list', options: [], purpose: 'sign' }
    expect(activeGestures(list).has('fingers')).toBe(true)
    expect(activeGestures(list).has('swipeLeft')).toBe(true)
    expect(activeGestures(signs).has('swipeLeft')).toBe(false)
    expect(activeGestures(quote).has('fingers')).toBe(false)
    expect(activeGestures(quote).has('swipeLeft')).toBe(true)
  })

  it('numbers the options each view offers', () => {
    expect(optionsFor({ kind: 'ready' })).toEqual([])
    expect(optionsFor({ kind: 'quickMenu', options: QUICK_MENU })).toEqual(QUICK_MENU)
    expect(optionsFor({ kind: 'settings', settings: { page: 'root' } })).toEqual(SETTINGS_ROOT)
    expect(optionsFor({ kind: 'done', ok: true, title: '', subtitle: '' })).toEqual(['View', 'New command', 'Save as gesture'])
    expect(optionsFor({ kind: 'done', ok: false, title: '', subtitle: '' })).toEqual(['View', 'New command'])
  })
})

describe('collapse and expand', () => {
  it('collapsed --palmHold--> ready', () => {
    c.setView({ kind: 'collapsed' })
    g('palmHold')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('expands straight into dictation in dictation mode', () => {
    setApp({ mode: 'dictation' })
    c.setView({ kind: 'collapsed' })
    g('palmHold')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
  })

  it('ready --fist--> collapsed', () => {
    g('fist')
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('maps the chevron and pill taps', () => {
    c.tap('collapse')
    expect(getApp().view.kind).toBe('collapsed')
    c.tap('expand')
    expect(getApp().view.kind).toBe('ready')
  })

  it('collapsing drops the phrase in progress', () => {
    sign(word('hello'), word('there'))
    g('fist')
    c.tap('expand')
    c.token(word('again'))
    expect(viewAs('recognizing').token).toBe('again')
  })

  it('toggles and persists the camera', () => {
    c.tap('camera')
    expect(getApp().cameraOn).toBe(false)
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraEnabled: false })
    c.tap('camera')
    expect(getApp().cameraOn).toBe(true)
  })
})

describe('modes', () => {
  it('swipeRight cycles command -> dictation -> spell -> command', () => {
    g('swipeRight')
    expect(getApp().mode).toBe('dictation')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    expect(api.saveSettings).toHaveBeenLastCalledWith({ mode: 'dictation' })

    g('swipeRight')
    expect(getApp().mode).toBe('spell')
    expect(getApp().view).toEqual({ kind: 'ready' })

    g('swipeRight')
    expect(getApp().mode).toBe('command')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('swipeLeft cycles backwards', () => {
    g('swipeLeft')
    expect(getApp().mode).toBe('spell')
    g('swipeLeft')
    expect(getApp().mode).toBe('dictation')
    expect(getApp().view.kind).toBe('dictation')
  })

  it('a fist in dictation returns to command mode', () => {
    g('swipeRight')
    g('fist')
    expect(getApp().mode).toBe('command')
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(api.saveSettings).toHaveBeenLastCalledWith({ mode: 'command' })
  })

  it('switching modes clears a quick-menu prefix', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    g('thumbsUp')
    fingers(1)
    g('swipeRight')
    g('swipeLeft')
    signSentence(...MEETING)
    await settle()
    expect(interpret.mock.calls[0][0].intentPrefix).toBeUndefined()
  })
})

describe('settings', () => {
  it('ready --swipeUp--> settings root', () => {
    g('swipeUp')
    expect(viewAs('settings').settings).toEqual({ page: 'root' })
  })

  it('root --4 fingers--> camera page --fist--> root --fist--> ready', async () => {
    await c.loadSettings()
    g('swipeUp')
    fingers(4)
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'mjpeg', url: STREAM })
    g('fist')
    expect(viewAs('settings').settings).toEqual({ page: 'root' })
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('backs out of settings into dictation when dictating', () => {
    setApp({ mode: 'dictation' })
    c.setView({ kind: 'dictation', text: '' })
    g('swipeUp')
    g('fist')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
  })

  it('camera page: choosing the built-in camera saves it', () => {
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'mjpeg', url: 'http://cam' } })
    fingers(1)
    expect(getApp().cameraSource).toEqual({ kind: 'builtin' })
    expect(api.saveSettings).toHaveBeenCalledWith({ cameraSource: { kind: 'builtin' }, cameraEnabled: true })
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'builtin', url: 'http://cam' })
  })

  it('camera page: choosing the stream switches the live source at once and saves it on its first frame', () => {
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'builtin', url: 'http://cam' } })
    fingers(2)
    expect(getApp().cameraSource).toEqual({ kind: 'mjpeg', url: 'http://cam' })
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraEnabled: true })
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'mjpeg', url: 'http://cam' })
    c.cameraStatus(null)
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraSource: { kind: 'mjpeg', url: 'http://cam' } })
  })

  it('camera page: the stream needs a URL first', async () => {
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'builtin', url: '' } })
    fingers(2)
    await settle()
    expect(api.saveSettings).not.toHaveBeenCalled()
    expect(getApp().notice).toBe('Set a stream URL first (option 3)')
  })

  it('camera page: picking a source turns a camera that was off back on', () => {
    setApp({ cameraOn: false })
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'builtin', url: 'http://cam' } })
    fingers(1)
    expect(getApp().cameraOn).toBe(true)
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ cameraEnabled: true }))
  })

  it('camera page: 3 fingers open the URL field; Return saves the URL and switches to it', () => {
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'builtin', url: STREAM } })
    fingers(3)
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'builtin', url: STREAM, editing: true })
    expect(api.saveSettings).not.toHaveBeenCalled()
    c.saveStreamUrl('  http://192.168.4.7:81/stream ')
    const source = { kind: 'mjpeg', url: 'http://192.168.4.7:81/stream' }
    expect(api.saveSettings).toHaveBeenCalledWith({ cameraEnabled: true, streamUrl: source.url })
    expect(getApp()).toMatchObject({ cameraSource: source, streamUrl: source.url })
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'mjpeg', url: source.url })
    c.cameraStatus(null)
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraSource: source })
  })

  it('camera page: a URL that is not http(s) is refused and the field stays open', () => {
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'builtin', url: '', editing: true } })
    c.saveStreamUrl('ftp://x/stream')
    expect(getApp().notice).toBe('Enter a URL starting with http://')
    expect(api.saveSettings).not.toHaveBeenCalled()
    expect(viewAs('settings').settings).toMatchObject({ editing: true })
  })

  it('camera page: hands typing the URL (a fist, finger counts) leave the field alone; a swipe left, Esc or the X close it', () => {
    setApp({ cameraSource: { kind: 'builtin' }, streamUrl: STREAM })
    const editing: SettingsPage = { page: 'camera', current: 'builtin', url: STREAM, editing: true }
    c.setView({ kind: 'settings', settings: editing })
    expect(activeGestures(getApp().view)).toEqual(new Set(['swipeLeft']))
    g('fist')
    fingers(1)
    fingers(2)
    expect(viewAs('settings').settings).toEqual(editing)
    expect(getApp().cameraSource).toEqual({ kind: 'builtin' })
    g('swipeLeft')
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'builtin', url: STREAM })
    g('swipeLeft') // the list itself has no swipe
    fingers(3)
    c.tap('close')
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'builtin', url: STREAM })
    c.tap('close')
    expect(viewAs('settings').settings).toEqual({ page: 'root' })
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('camera page: a stream that fails before its first frame gives way to the MacBook camera, which is saved', () => {
    setApp({ cameraSource: { kind: 'builtin' }, streamUrl: STREAM })
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'builtin', url: STREAM } })
    fingers(3)
    c.saveStreamUrl('http://192.168.1.99:81/stream')
    expect(getApp().cameraSource).toEqual({ kind: 'mjpeg', url: 'http://192.168.1.99:81/stream' })
    c.cameraStatus("Can't reach the ESP32 stream")
    expect(getApp()).toMatchObject({ cameraSource: { kind: 'builtin' }, streamUrl: 'http://192.168.1.99:81/stream' })
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraSource: { kind: 'builtin' } })
    expect(getApp().notice).toBe("Can't reach the ESP32 stream. Using the MacBook camera.")
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'builtin', url: 'http://192.168.1.99:81/stream' })
    // Hands work again: 2 fingers retry the stream once the camera is fixed.
    fingers(2)
    expect(getApp().cameraSource).toEqual({ kind: 'mjpeg', url: 'http://192.168.1.99:81/stream' })
  })

  it('camera page: a stream that showed a frame stays through later failures (the pipeline retries it)', () => {
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'builtin', url: STREAM } })
    fingers(2)
    c.cameraStatus(null)
    c.cameraStatus('Lost the ESP32 stream')
    expect(getApp().cameraSource).toEqual({ kind: 'mjpeg', url: STREAM })
    expect(api.saveSettings).toHaveBeenCalledTimes(2)
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraSource: { kind: 'mjpeg', url: STREAM } })
    expect(getApp().notice).toBeNull()
  })

  it('camera page: picking the stream that is already showing frames has nothing to wait for', () => {
    setApp({ cameraSource: { kind: 'mjpeg', url: STREAM } })
    live.mock = false
    try {
      c.setView({ kind: 'settings', settings: { page: 'camera', current: 'mjpeg', url: STREAM } })
      fingers(2)
      expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraSource: { kind: 'mjpeg', url: STREAM }, cameraEnabled: true })
      c.cameraStatus('Lost the ESP32 stream')
      expect(getApp().cameraSource).toEqual({ kind: 'mjpeg', url: STREAM })
    } finally {
      live.mock = true
    }
  })

  it('camera page: the MacBook camera never gives way', () => {
    setApp({ cameraSource: { kind: 'mjpeg', url: STREAM } })
    c.setView({ kind: 'settings', settings: { page: 'camera', current: 'mjpeg', url: STREAM } })
    fingers(1)
    c.cameraStatus('Camera access denied')
    expect(getApp().cameraSource).toEqual({ kind: 'builtin' })
    expect(getApp().notice).toBeNull()
  })

  it('camera page: the stream URL outlives picking the MacBook camera', async () => {
    await c.loadSettings()
    c.openSettings()
    fingers(4)
    fingers(1)
    g('fist')
    fingers(4)
    expect(viewAs('settings').settings).toEqual({ page: 'camera', current: 'builtin', url: STREAM })
    fingers(2)
    expect(getApp().cameraSource).toEqual({ kind: 'mjpeg', url: STREAM })
  })

  it('sensitivity page saves the choice', () => {
    g('swipeUp')
    fingers(5)
    expect(viewAs('settings').settings).toEqual({ page: 'sensitivity', current: 'medium' })
    fingers(3)
    expect(getApp().sensitivity).toBe('high')
    expect(api.saveSettings).toHaveBeenLastCalledWith({ sensitivity: 'high' })
    expect(viewAs('settings').settings).toEqual({ page: 'sensitivity', current: 'high' })
  })

  it('new gesture lists recent tasks, then holds for the shape', async () => {
    c.openSettings()
    fingers(2)
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Open Notes'] })
    fingers(1)
    expect(viewAs('settings').settings).toEqual({ page: 'newGestureHold', task: 'Open Notes', countdown: 3 })
  })

  it('my gestures -> detail -> back to the list; built-ins cannot be deleted', async () => {
    c.openSettings()
    fingers(3)
    await settle()
    const list = viewAs('settings').settings
    expect(list).toMatchObject({ page: 'gestures' })
    expect(optionsFor(getApp().view)).toEqual(['Peace sign', 'Rock on'])

    fingers(1)
    expect(viewAs('settings').settings).toMatchObject({ page: 'gestureDetail', gesture: { id: 'builtin-peace' } })
    expect(optionsFor(getApp().view)).toEqual(['Test it'])
    fingers(2)
    expect(api.saveGestures).not.toHaveBeenCalled()

    g('fist')
    await settle()
    expect(viewAs('settings').settings).toMatchObject({ page: 'gestures' })
  })

  it('deleting a custom gesture saves the rest', async () => {
    c.setView({ kind: 'settings', settings: { page: 'gestureDetail', gesture: GESTURES[1] } })
    fingers(2)
    await settle()
    expect(api.saveGestures).toHaveBeenCalledWith([GESTURES[0]])
    expect(viewAs('settings').settings).toMatchObject({ page: 'gestures' })
  })

  it('"Test it" runs the shortcut and toasts back to ready', async () => {
    c.setView({ kind: 'settings', settings: { page: 'gestureDetail', gesture: GESTURES[0] } })
    fingers(1)
    await settle(400)
    expect(viewAs('toast')).toMatchObject({ title: 'Screenshot taken', returnTo: 'ready' })
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'ready' })
  })
})

/**
 * Every Settings page reached and left by hand, with the inputs the dev simulator sends
 * (Ctrl+Opt+1…5: fingers, Ctrl+Opt+F: fist, Ctrl+Opt+arrows: swipes), and what each pick changes.
 */
describe('settings by hand', () => {
  const page = (): SettingsPage => viewAs('settings').settings

  it.each([
    ['Ready', [], { kind: 'ready' }],
    ['Dictation', ['swipeRight'], { kind: 'dictation', text: '' }],
    ['Spell mode', ['swipeLeft'], { kind: 'ready' }]
  ] as const)('%s: swipe up opens Settings, and a fist on its first page goes back', (_, enter, idle) => {
    enter.forEach(g)
    g('swipeUp')
    expect(page()).toEqual({ page: 'root' })
    expect(optionsFor(getApp().view)).toEqual(SETTINGS_ROOT)
    g('fist')
    expect(getApp().view).toEqual(idle)
  })

  it('Done: swipe up opens Settings, which stops the collapse; a fist goes to Ready', async () => {
    await toAgentReady()
    g('thumbsUp')
    await settle(1400)
    g('thumbsUp') // approves the mock agent's confirm step
    await settle(1400)
    expect(viewAs('done').ok).toBe(true)
    g('swipeUp')
    await settle(DONE_AUTO_COLLAPSE_MS * 2)
    expect(page()).toEqual({ page: 'root' })
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('1 Teach a sign: swipes page, fingers pick a sign (5: Spell a new word), and back leads to Settings', () => {
    c.openSettings()
    fingers(1)
    expect(page()).toMatchObject({ page: 'teachPick', offset: 0 })
    expect(optionsFor(getApp().view)).toEqual(['YES', 'NO', 'HELLO', 'MEETING', 'Spell a new word'])
    g('swipeRight')
    fingers(1)
    expect(page()).toEqual({ page: 'teachRecord', label: 'TOMORROW', kind: 'word', done: 0, total: 5 })
    g('fist')
    expect(page()).toMatchObject({ page: 'teachPick', offset: 4 })
    // A letter's page goes back by swipe: S, T, M and N are held still like a fist.
    for (let i = 0; i < 3; i++) g('swipeRight')
    fingers(1)
    expect(page()).toEqual({ page: 'teachRecord', label: 'A', kind: 'letter', done: 0, total: 5 })
    g('fist')
    expect(page()).toMatchObject({ page: 'teachRecord', label: 'A' })
    g('swipeLeft')
    expect(page()).toMatchObject({ page: 'teachPick', offset: 16 })
    for (let i = 0; i < 4; i++) g('swipeLeft')
    fingers(5)
    expect(page()).toEqual({ page: 'teachSpell', letters: '', canSpell: false })
    g('fist')
    expect(page()).toMatchObject({ page: 'teachPick', offset: 0 })
    g('fist')
    expect(page()).toEqual({ page: 'root' })
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('2 New gesture: fingers pick the task and start the countdown; swipe left and a fist lead back', async () => {
    c.openSettings()
    fingers(2)
    await settle()
    expect(page()).toEqual({ page: 'newGesturePick', tasks: ['Open Notes'] })
    fingers(1)
    expect(page()).toEqual({ page: 'newGestureHold', task: 'Open Notes', countdown: 3 })
    g('fist') // the shape being formed may read as a fist: only a swipe goes back
    expect(page()).toMatchObject({ page: 'newGestureHold' })
    g('swipeLeft')
    await settle()
    expect(page()).toEqual({ page: 'newGesturePick', tasks: ['Open Notes'] })
    g('fist')
    expect(page()).toEqual({ page: 'root' })
  })

  it('3 My gestures: fingers open a gesture, and fists lead back to the list and to Settings', async () => {
    c.openSettings()
    fingers(3)
    await settle()
    expect(optionsFor(getApp().view)).toEqual(['Peace sign', 'Rock on'])
    fingers(2)
    expect(page()).toMatchObject({ page: 'gestureDetail', gesture: { id: 'g2' } })
    expect(optionsFor(getApp().view)).toEqual(['Test it', 'Delete'])
    g('fist')
    await settle()
    expect(page()).toMatchObject({ page: 'gestures', offset: 0 })
    g('fist')
    expect(page()).toEqual({ page: 'root' })
  })

  it('4 Camera source: each pick switches the source at once and is saved (a stream on its first frame); 3 opens the URL field', async () => {
    await c.loadSettings() // the ESP32 stream is the saved source
    c.openSettings()
    fingers(4)
    expect(page()).toEqual({ page: 'camera', current: 'mjpeg', url: STREAM })
    fingers(1)
    expect(getApp().cameraSource).toEqual({ kind: 'builtin' })
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraSource: { kind: 'builtin' }, cameraEnabled: true })
    fingers(2)
    expect(getApp().cameraSource).toEqual({ kind: 'mjpeg', url: STREAM })
    c.cameraStatus(null) // its first frame
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraSource: { kind: 'mjpeg', url: STREAM } })
    fingers(3)
    expect(page()).toMatchObject({ page: 'camera', editing: true })
    c.saveStreamUrl('http://10.0.0.9:81/stream')
    expect(getApp().cameraSource).toEqual({ kind: 'mjpeg', url: 'http://10.0.0.9:81/stream' })
    c.cameraStatus(null)
    expect(api.saveSettings).toHaveBeenLastCalledWith({ cameraSource: { kind: 'mjpeg', url: 'http://10.0.0.9:81/stream' } })
    expect(api.saveSettings).toHaveBeenCalledTimes(5)
    g('fist')
    expect(page()).toEqual({ page: 'root' })
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('5 Sensitivity: each level is picked by fingers, saved and applied at once', () => {
    c.openSettings()
    fingers(5) // an open palm held 0.8 s
    expect(page()).toEqual({ page: 'sensitivity', current: 'medium' })
    for (const [count, level] of [[1, 'low'], [3, 'high'], [2, 'medium']] as const) {
      fingers(count)
      expect(getApp().sensitivity).toBe(level)
      expect(api.saveSettings).toHaveBeenLastCalledWith({ sensitivity: level })
      expect(page()).toEqual({ page: 'sensitivity', current: level })
    }
    fingers(4) // three levels only
    expect(api.saveSettings).toHaveBeenCalledTimes(3)
    g('fist')
    expect(page()).toEqual({ page: 'root' })
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })
})

describe('new gesture', () => {
  const SHAPE = [[0.1, 0.2], [0.1, 0.25]]
  const hold = (): Extract<SettingsPage, { page: 'newGestureHold' }> => {
    const page = viewAs('settings').settings
    expect(page.page).toBe('newGestureHold')
    return page as Extract<SettingsPage, { page: 'newGestureHold' }>
  }
  /** Settings › New gesture › 1 (Open Notes): the countdown starts. */
  async function pickTask(): Promise<void> {
    c.openSettings()
    fingers(2)
    await settle()
    fingers(1)
  }

  it('counts 3, 2, 1 down, then records the shape', async () => {
    await pickTask()
    expect(hold()).toEqual({ page: 'newGestureHold', task: 'Open Notes', countdown: 3 })
    expect(isCapturingShape(getApp().view)).toBe(false)
    await settle(1000)
    expect(hold().countdown).toBe(2)
    await settle(1000)
    expect(hold().countdown).toBe(1)
    await settle(1000)
    expect(hold()).toEqual({ page: 'newGestureHold', task: 'Open Notes', countdown: 0 })
    expect(isCapturingShape(getApp().view)).toBe(true)
  })

  it('takes a verdict only while recording; a refused shape says why and thumbs up records again', async () => {
    await pickTask()
    c.shapeCaptured({ ok: true, shape: SHAPE }) // still counting down
    await settle(3000)
    expect(api.saveGestures).not.toHaveBeenCalled()
    const reason = CAPTURE_REASONS.control('a fist')
    c.shapeCaptured({ ok: false, reason })
    expect(hold()).toEqual({ page: 'newGestureHold', task: 'Open Notes', countdown: 0, reason })
    expect(isCapturingShape(getApp().view)).toBe(false)
    c.shapeCaptured({ ok: true, shape: SHAPE }) // a late verdict for the refused recording
    await settle()
    expect(api.saveGestures).not.toHaveBeenCalled()
    g('thumbsUp')
    expect(hold()).toEqual({ page: 'newGestureHold', task: 'Open Notes', countdown: 3 })
  })

  it('without camera frames the recording times out: no hand seen, or the camera is off', async () => {
    await pickTask()
    await settle(3000 + 2499)
    expect(isCapturingShape(getApp().view)).toBe(true)
    await settle(1)
    expect(hold().reason).toBe(CAPTURE_REASONS.noHand)
    setApp({ cameraOn: false })
    g('thumbsUp')
    await settle(3000 + 2500)
    expect(hold().reason).toBe('The camera is off. Turn it on first.')
  })

  it('saves the shape as the next "Gesture N", added to the file, and toasts its way to My gestures', async () => {
    await pickTask()
    await settle(3000)
    c.shapeCaptured({ ok: true, shape: SHAPE })
    await settle()
    const gesture = { id: expect.stringMatching(/^gesture-/), name: 'Gesture 2', task: 'Open Notes', shape: SHAPE, createdAt: expect.any(Number) }
    expect(api.saveGestures).toHaveBeenCalledWith([...GESTURES, gesture])
    expect(getApp().gestures).toEqual([...GESTURES, gesture])
    expect(viewAs('toast')).toMatchObject({ title: 'Gesture saved', subtitle: 'Gesture 2 · Open Notes', ok: true })
    // The recording's timeout was cleared: nothing replaces the toast.
    await settle(TOAST_MS - 1)
    viewAs('toast')
    await settle(1)
    expect(viewAs('settings').settings).toMatchObject({ page: 'gestures', offset: 0 })
    expect(optionsFor(getApp().view)).toEqual(['Peace sign', 'Rock on', 'Gesture 2'])
  })

  it('a save that fails keeps the page, with the reason', async () => {
    api.saveGestures.mockRejectedValueOnce(new Error('disk full'))
    await pickTask()
    await settle(3000)
    c.shapeCaptured({ ok: true, shape: SHAPE })
    await settle()
    expect(hold().reason).toBe("Couldn't save it: disk full")
    expect(getApp().gestures).toEqual([])
  })

  it('names gestures after the first free number (the peace sign is gesture 1)', () => {
    expect(nextGestureName([])).toBe('Gesture 2')
    expect(nextGestureName([{ name: 'Peace sign' }, { name: 'Gesture 2' }, { name: 'Gesture 4' }])).toBe('Gesture 3')
  })

  it('while the shape is formed only a swipe goes back (the shape may read as a fist); a refusal adds thumbs up and the fist', async () => {
    await pickTask()
    expect(activeGestures(getApp().view)).toEqual(new Set(['swipeLeft']))
    g('fist')
    hold()
    g('swipeLeft')
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Open Notes'] })
    await settle(6000) // the countdown stopped with the page
    expect(viewAs('settings').settings.page).toBe('newGesturePick')

    fingers(1)
    await settle(3000)
    c.shapeCaptured({ ok: false, reason: CAPTURE_REASONS.moved })
    expect(activeGestures(getApp().view)).toEqual(new Set(['thumbsUp', 'fist', 'swipeLeft']))
    g('fist')
    await settle()
    expect(viewAs('settings').settings.page).toBe('newGesturePick')
  })

  describe('Sign a new task', () => {
    /** Settings › New gesture › 2 (Sign a new task, after Open Notes). */
    async function signNewTask(): Promise<void> {
      c.openSettings()
      fingers(2)
      await settle()
      fingers(2)
    }

    it("goes to Ready with a hint; the proceeded phrase's intent becomes the task instead of an agent run", async () => {
      const agentRun = vi.spyOn(services, 'agentRun')
      await signNewTask()
      expect(getApp().view).toEqual({ kind: 'ready', hint: 'Sign the task for your gesture' })
      signSentence(...MEETING)
      g('thumbsUp')
      await settle(500)
      expect(hold()).toEqual({ page: 'newGestureHold', task: 'Schedule a meeting tomorrow at 3pm with the team', countdown: 3 })
      expect(agentRun).not.toHaveBeenCalled()
      // The phrase is used up: backing out of Settings leads to a plain Ready.
      g('swipeLeft')
      await settle()
      g('fist')
      g('fist')
      expect(getApp().view).toEqual({ kind: 'ready' })
    })

    it("takes Claude's sentence when it found no intent, without asking Did you mean", async () => {
      await signNewTask()
      signSentence(word('what'), word('time'))
      g('thumbsUp')
      await settle(500)
      expect(hold().task).toBe('What time is my next meeting?')
    })

    it('takes the signed sentence without Claude, and says why', async () => {
      vi.spyOn(services, 'interpret').mockResolvedValue({ ok: false, error: 'no key', missingKey: 'ANTHROPIC_API_KEY' })
      await signNewTask()
      signSentence(...MEETING)
      g('thumbsUp')
      await settle()
      expect(hold().task).toBe('Meeting tomorrow at 3 pm')
      expect(getApp().notice).toBe('Add ANTHROPIC_API_KEY to .env')
    })

    it('keeps a quick-menu pick as the task prefix', async () => {
      vi.spyOn(services, 'interpret').mockResolvedValue({ ok: false, error: 'offline' })
      await signNewTask()
      g('thumbsUp')
      fingers(4) // Take notes
      expect(getApp().view).toEqual({ kind: 'ready', hint: 'Take notes: sign the details' })
      signSentence(...MEETING)
      g('thumbsUp')
      await settle()
      expect(hold().task).toBe('Take notes: Meeting tomorrow at 3 pm')
    })

    it('signs in Command mode, and ends with the phrase', async () => {
      setApp({ mode: 'dictation' })
      c.setView({ kind: 'dictation', text: '' })
      await signNewTask()
      expect(getApp().mode).toBe('command')
      expect(getApp().view).toEqual({ kind: 'ready', hint: 'Sign the task for your gesture' })
      signSentence(...MEETING)
      g('fist') // cancel
      expect(getApp().view).toEqual({ kind: 'ready' })
    })
  })

  it('My gestures pages through a long list, four at a time', async () => {
    const many: CustomGesture[] = [GESTURES[0], ...[2, 3, 4, 5, 6].map((n) => ({ id: `g${n}`, name: `Gesture ${n}`, task: `Task ${n}`, shape: [], createdAt: n }))]
    api.getGestures.mockResolvedValue(many)
    c.openSettings()
    fingers(3)
    await settle()
    expect(optionsFor(getApp().view)).toEqual(['Peace sign', 'Gesture 2', 'Gesture 3', 'Gesture 4'])
    expect(getApp().gestures).toEqual(many)
    g('swipeLeft') // already on the first page
    expect(viewAs('settings').settings).toMatchObject({ offset: 0 })
    g('swipeRight')
    expect(optionsFor(getApp().view)).toEqual(['Gesture 5', 'Gesture 6'])
    g('swipeRight') // no third page
    fingers(2)
    expect(viewAs('settings').settings).toMatchObject({ page: 'gestureDetail', gesture: { id: 'g6' } })
    g('fist')
    await settle()
    expect(viewAs('settings').settings).toMatchObject({ page: 'gestures', offset: 4 })
    g('swipeLeft')
    expect(viewAs('settings').settings).toMatchObject({ offset: 0 })
  })

  it('deleting a gesture updates the store the shape matcher follows', async () => {
    let file = [...GESTURES]
    api.getGestures.mockImplementation(async () => file)
    api.saveGestures.mockImplementation(async (gestures: CustomGesture[]) => void (file = gestures))
    await c.loadGestures()
    expect(getApp().gestures).toEqual(GESTURES)
    c.setView({ kind: 'settings', settings: { page: 'gestureDetail', gesture: GESTURES[1] } })
    fingers(2)
    await settle()
    expect(getApp().gestures).toEqual([GESTURES[0]])
  })
})

describe('teach a sign', () => {
  /** A stored template (frames don't matter to the controller). */
  const tpl = (label: string, n: number): SignTemplate => ({
    id: `${label}-${n}`,
    label,
    kind: label.length === 1 ? 'letter' : 'word',
    frames: [],
    createdAt: n
  })
  const RECORD_MEETING = { page: 'teachRecord', label: 'MEETING', kind: 'word', done: 0, total: 5 } as const
  const RECORD_S = { page: 'teachRecord', label: 'S', kind: 'letter', done: 0, total: 5 } as const
  /** S is letter 18 of the list after the 16 starter words: the page at offset 32. */
  const S_PAGE = 32
  /** Spell a new word with some letter taught. */
  const spelling = (letters: string): SettingsPage => ({ page: 'teachSpell', letters, canSpell: true })

  it('lists starter words and letters by page, with the recorded count per label', () => {
    setApp({ templates: [tpl('YES', 1), tpl('YES', 2), tpl('V', 3)] })
    c.openSettings()
    fingers(1)
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 0, recorded: { YES: 2, V: 1 } })
    expect(optionsFor(getApp().view)).toEqual(['YES', 'NO', 'HELLO', 'MEETING', 'Spell a new word'])
    g('swipeLeft')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 0 })
    g('swipeRight')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 4 })
    for (let i = 0; i < 20; i++) g('swipeRight')
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 36, recorded: { YES: 2, V: 1 } })
    expect(optionsFor(getApp().view)).toEqual(['V', 'W', 'X', 'Y', 'Spell a new word'])
  })

  it('records words and letters 5 times each; the last option spells a new word', () => {
    const list = (offset: number): View => ({ kind: 'settings', settings: { page: 'teachPick', offset, recorded: {} } })
    c.setView(list(0))
    fingers(4)
    expect(viewAs('settings').settings).toEqual(RECORD_MEETING)
    c.setView(list(16))
    fingers(1)
    expect(viewAs('settings').settings).toMatchObject({ label: 'A', kind: 'letter', total: 5 })
    c.setView(list(0))
    fingers(5)
    expect(viewAs('settings').settings).toEqual({ page: 'teachSpell', letters: '', canSpell: false })
    setApp({ templates: [tpl('S', 1)] })
    c.setView(list(0))
    fingers(5)
    expect(viewAs('settings').settings).toEqual({ page: 'teachSpell', letters: '', canSpell: true })
  })

  it('shows the recorder listening, then each judged repetition with its reason', () => {
    c.setView({ kind: 'settings', settings: RECORD_MEETING })
    c.teachListening()
    expect(viewAs('settings').settings).toEqual({ ...RECORD_MEETING, listening: true })
    c.teachProgress(1)
    expect(viewAs('settings').settings).toMatchObject({ done: 1, listening: false, reason: undefined })
    c.teachListening()
    c.teachProgress(1, 'Too short. Sign the whole word, then hold still.')
    expect(viewAs('settings').settings).toMatchObject({ done: 1, listening: false, reason: expect.stringMatching(/^Too short/) })
  })

  it('ignores recorder updates on other pages', () => {
    const root: View = { kind: 'settings', settings: { page: 'root' } }
    c.setView(root)
    c.teachListening()
    c.teachProgress(3)
    expect(getApp().view).toBe(root)
  })

  it('saves a learned sign next to the recorded ones, toasts, then shows its page of the list', async () => {
    api.getTemplates.mockResolvedValue({ version: 1, templates: [tpl('YES', 1)] })
    c.setView({ kind: 'settings', settings: { ...RECORD_MEETING, done: 10 } })
    const learned = [tpl('MEETING', 10), tpl('MEETING', 11)]
    await c.teachLearned('MEETING', learned)
    const templates = [tpl('YES', 1), ...learned]
    expect(api.saveTemplates).toHaveBeenCalledWith({ version: 1, templates })
    expect(getApp().templates).toEqual(templates)
    expect(viewAs('toast')).toMatchObject({ title: 'Learned MEETING', subtitle: '2 recordings saved', ok: true })
    await settle(TOAST_MS)
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 0, recorded: { YES: 1, MEETING: 2 } })
  })

  it('reports a failed save and still returns to the list', async () => {
    api.saveTemplates.mockRejectedValue(new Error('disk full'))
    c.setView({ kind: 'settings', settings: { ...RECORD_S, done: 5 } })
    await c.teachLearned('S', [tpl('S', 1)])
    expect(viewAs('toast')).toMatchObject({ title: "Couldn't save S", subtitle: 'disk full', ok: false })
    expect(getApp().templates).toEqual([])
    g('fist')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: S_PAGE })
  })

  it('goes back to the list with a fist from a word and a swipe left from a letter (a held S reads as a fist)', () => {
    c.setView({ kind: 'settings', settings: RECORD_S })
    expect(activeGestures(getApp().view)).toEqual(new Set(['swipeLeft']))
    g('fist')
    expect(viewAs('settings').settings).toEqual(RECORD_S)
    g('swipeLeft')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: S_PAGE })

    c.setView({ kind: 'settings', settings: RECORD_MEETING })
    expect(activeGestures(getApp().view)).toEqual(new Set(['fist']))
    g('fist')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 0 })
  })

  it('spell a new word: letters append, swipe left deletes one, thumbs up records it as a word', () => {
    c.setView({ kind: 'settings', settings: spelling('') })
    g('thumbsUp')
    expect(getApp().notice).toBe('Spell or type the word first')
    sign(letter('K'), letter('C'), word('hello'), letter('X'))
    expect(viewAs('settings').settings).toEqual(spelling('KCX'))
    g('swipeLeft')
    fingers(2)
    expect(viewAs('settings').settings).toEqual(spelling('KC'))
    g('thumbsUp')
    expect(viewAs('settings').settings).toEqual({ page: 'teachRecord', label: 'KC', kind: 'word', done: 0, total: 5 })
    g('fist')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 0 })
  })

  it('spell a new word: swipe left past the first letter goes back (a taught S held there is a letter, not a fist)', () => {
    c.setView({ kind: 'settings', settings: spelling('S') })
    g('swipeLeft')
    expect(viewAs('settings').settings).toEqual(spelling(''))
    g('swipeLeft')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 0 })
  })

  it('spell a new word: typed text is upper-cased and cleaned up, and Return records it', () => {
    c.setView({ kind: 'settings', settings: spelling('') })
    c.setTeachWord('  cal  hacks!')
    expect(viewAs('settings').settings).toEqual(spelling('CAL HACKS'))
    c.confirmTeachWord()
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachRecord', label: 'CAL HACKS', kind: 'word' })
  })

  it('loads the recorded signs into the store', async () => {
    api.getTemplates.mockResolvedValue({ version: 1, templates: [tpl('YES', 1)] })
    await c.loadTemplates()
    expect(getApp().templates).toEqual([tpl('YES', 1)])
  })

  it('reloaded signs (a tray import) update an open teach page', async () => {
    c.setView({ kind: 'settings', settings: { page: 'teachPick', offset: 4, recorded: {} } })
    api.getTemplates.mockResolvedValue({ version: 1, templates: [tpl('YES', 1), tpl('HELLO', 2), tpl('S', 3)] })
    await c.loadTemplates()
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 4, recorded: { YES: 1, HELLO: 1, S: 1 } })
    c.setView({ kind: 'settings', settings: { page: 'teachSpell', letters: 'K', canSpell: false } })
    await c.loadTemplates()
    expect(viewAs('settings').settings).toEqual(spelling('K'))
  })
})

describe('listening', () => {
  it('signStart in ready shows listening', () => {
    c.signStart()
    expect(getApp().view).toEqual({ kind: 'recognizing', token: null, isWord: false })
  })

  it('returns to ready when the movement was no sign; a recognized sign stays', () => {
    c.signStart()
    c.signRejected()
    expect(getApp().view).toEqual({ kind: 'ready' })
    c.signStart()
    c.token(word('hello'))
    c.signRejected()
    expect(viewAs('recognizing').token).toBe('hello')
  })

  it('keeps a quick-menu pick waiting for its details', () => {
    c.setView({ kind: 'quickMenu', options: QUICK_MENU })
    fingers(2)
    c.signStart()
    c.signRejected()
    expect(getApp().view).toEqual({ kind: 'ready', hint: `${QUICK_MENU[1]}: sign the details` })
  })

  it("keeps Ready's gestures: a fist raised into view collapses, a thumbs-up opens the quick menu", () => {
    c.signStart()
    expect(activeGestures(getApp().view)).toEqual(activeGestures({ kind: 'ready' }))
    g('fist')
    expect(getApp().view).toEqual({ kind: 'collapsed' })
    c.expand()
    c.signStart()
    g('thumbsUp')
    expect(viewAs('quickMenu').options).toEqual(QUICK_MENU)
  })

  it('counts as Ready when a new screen needs a fresh gesture', () => {
    expect(gestureScreen({ kind: 'recognizing', token: null, isWord: false })).toBe('ready')
    expect(gestureScreen({ kind: 'recognizing', token: 'A', isWord: false })).toBe('recognizing')
    expect(gestureScreen({ kind: 'settings', settings: { page: 'root' } })).toBe('settings')
    // A refused shape (often a fist or thumbs up still held) needs a fresh gesture to retry or go back.
    const hold: SettingsPage = { page: 'newGestureHold', task: 't', countdown: 0 }
    expect(gestureScreen({ kind: 'settings', settings: hold })).toBe('shapeHold')
    expect(gestureScreen({ kind: 'settings', settings: { ...hold, reason: 'r' } })).toBe('shapeRefused')
  })

  it('feeds recognition only in views that take signs', () => {
    const yes: View[] = [
      { kind: 'ready' },
      { kind: 'recognizing', token: null, isWord: false },
      { kind: 'building', tokens: [], current: null, sentence: '' },
      { kind: 'sentence', sentence: 'Hi', tokens: [] },
      { kind: 'dictation', text: '' },
      { kind: 'settings', settings: { page: 'teachSpell', letters: '', canSpell: true } }
    ]
    const no: View[] = [
      { kind: 'collapsed' },
      { kind: 'working', intent: 'x', steps: [] },
      { kind: 'toast', title: 't', ok: true, returnTo: 'ready' },
      { kind: 'quickMenu', options: QUICK_MENU },
      { kind: 'settings', settings: { page: 'root' } },
      { kind: 'settings', settings: { page: 'teachRecord', label: 'YES', kind: 'word', done: 0, total: 5 } }
    ]
    expect(yes.map(takesSigns)).toEqual(yes.map(() => true))
    expect(no.map(takesSigns)).toEqual(no.map(() => false))
  })
})

describe('phrase building', () => {

  it('first token -> recognizing, the next -> building with the assembled sentence', () => {
    c.token(word('meeting'))
    expect(getApp().view).toEqual({ kind: 'recognizing', token: 'meeting', isWord: true })
    c.token(word('tomorrow'))
    expect(getApp().view).toEqual({
      kind: 'building',
      tokens: [word('meeting'), word('tomorrow')],
      current: 'tomorrow',
      sentence: 'Meeting tomorrow'
    })
  })

  it('a first letter is not flagged as a word', () => {
    c.token(letter('A'))
    expect(getApp().view).toEqual({ kind: 'recognizing', token: 'A', isWord: false })
  })

  it('fingerspelled letters build one word', () => {
    sign(letter('A'), letter('M'), letter('C'))
    expect(viewAs('building')).toMatchObject({ current: 'C', sentence: 'AMC' })
  })

  it('swipeLeft deletes the last word', () => {
    sign(...MEETING)
    g('swipeLeft')
    expect(viewAs('building')).toMatchObject({ tokens: MEETING.slice(0, 4), current: null, sentence: 'Meeting tomorrow at 3' })
  })

  it('swipeLeft deletes a whole trailing letter run', () => {
    sign(word('call'), letter('K'), letter('C'))
    g('swipeLeft')
    expect(viewAs('building')).toMatchObject({ tokens: [word('call')], sentence: 'Call' })
  })

  it('deleting the last word returns to ready', () => {
    sign(letter('K'), letter('C'))
    g('swipeLeft')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it.each(['handsDown', 'thumbsUp', 'swipeRight'] as const)('%s in building -> sentence', (gesture) => {
    sign(...MEETING)
    g(gesture)
    expect(getApp().view).toEqual({ kind: 'sentence', sentence: 'Meeting tomorrow at 3 pm', tokens: MEETING })
  })

  it('the proceed button and phraseEnd() also end the phrase', () => {
    sign(word('hi'), word('there'))
    c.tap('proceed')
    expect(viewAs('sentence').sentence).toBe('Hi there')

    c.tap('close')
    sign(word('hi'))
    c.phraseEnd()
    expect(viewAs('sentence').sentence).toBe('Hi')
  })

  it('ending a phrase with nothing signed returns to ready', () => {
    c.signStart()
    c.tap('proceed')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('fist cancels the phrase', () => {
    sign(word('hi'), word('there'))
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
    c.token(word('again'))
    expect(viewAs('recognizing').token).toBe('again')
  })

  it('swipeLeft on the sentence removes a word and stays on the sentence', () => {
    signSentence(...MEETING)
    g('swipeLeft')
    expect(viewAs('sentence')).toMatchObject({ sentence: 'Meeting tomorrow at 3', tokens: MEETING.slice(0, 4) })
  })

  it('signing more on the sentence keeps building', () => {
    signSentence(word('meeting'), word('tomorrow'))
    c.token(word('morning'))
    expect(viewAs('building')).toMatchObject({ sentence: 'Meeting tomorrow morning', current: 'morning' })
  })

  it('ignores tokens in views that are not collecting a phrase', () => {
    const settings: View = { kind: 'settings', settings: { page: 'root' } }
    c.setView(settings)
    c.token(word('hi'))
    expect(getApp().view).toBe(settings)
  })
})

describe('interpretation', () => {
  it('sentence --thumbsUp--> thinking, then agentReady with the intent', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    signSentence(...MEETING)
    g('thumbsUp')
    expect(viewAs('sentence').thinking).toBe(true)
    await settle(500)
    expect(getApp().view).toEqual({
      kind: 'agentReady',
      intent: 'Schedule a meeting tomorrow at 3pm with the team',
      variant: 'default',
      target: undefined,
      sentence: 'Meeting tomorrow at 3pm.'
    })
    // Prefetched when the phrase ended, reused on proceed.
    expect(interpret).toHaveBeenCalledTimes(1)
    const req = interpret.mock.calls[0][0]
    expect(req).toMatchObject({
      tokens: ['meeting', 'tomorrow', 'at', '3', 'pm'],
      sentence: 'Meeting tomorrow at 3 pm',
      mode: 'command',
      frontmost: { name: 'Mail', windowTitle: 'New Message' },
      gestures: [
        { name: 'Peace sign', task: 'Take a screenshot' },
        { name: 'Rock on', task: 'Play Motion Sickness' }
      ]
    })
    expect(req.intentPrefix).toBeUndefined()
  })

  it('an intent with an email address uses the email variant', async () => {
    signSentence(word('email'), word('team'))
    g('thumbsUp')
    await settle(500)
    expect(viewAs('agentReady')).toMatchObject({ variant: 'email', target: 'team@company.com' })
  })

  it('low confidence offers a numbered "did you mean" list, picked by fingers', async () => {
    signSentence(word('what'), word('time'), word('next'), word('meeting'))
    g('thumbsUp')
    await settle(500)
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
      variant: 'list',
      options: ['Show my next meeting', 'What time is it?', 'Open Calendar', 'Insert text'],
      purpose: 'intent',
      quote: 'What time is my next meeting?'
    })
    fingers(2)
    expect(getApp().view).toEqual({
      kind: 'agentReady',
      intent: 'What time is it?',
      variant: 'default',
      sentence: 'What time is my next meeting?'
    })
  })

  it('a low-confidence intent is listed first', async () => {
    vi.spyOn(services, 'interpret').mockResolvedValue({
      ok: true,
      value: intentResult({ intent: 'Open Notes', alternatives: ['Open Notes', 'Take notes'], confidence: 0.4 })
    })
    signSentence(word('notes'))
    g('thumbsUp')
    await settle()
    expect(viewAs('didYouMean').options).toEqual(['Open Notes', 'Take notes'])
  })

  it('no intent but context actions -> contextActions, Insert text first and More options last', async () => {
    vi.spyOn(services, 'interpret').mockResolvedValue({
      ok: true,
      value: intentResult({ context_actions: ['Send message', 'More options', 'Type it', 'Reply', 'Extra'] })
    })
    signSentence(word('update'))
    g('thumbsUp')
    await settle()
    expect(getApp().view).toEqual({
      kind: 'contextActions',
      sentence: 'Here is the update',
      actions: ['Insert text', 'Send message', 'Reply', 'More options']
    })
  })

  it('context action "Insert text" types the sentence and toasts', async () => {
    const typeText = vi.spyOn(services, 'typeText')
    c.setView({ kind: 'contextActions', sentence: 'Here is the update', actions: ['Insert text', 'Send message'] })
    fingers(1)
    await settle()
    expect(typeText).toHaveBeenCalledWith('Here is the update')
    expect(viewAs('toast')).toMatchObject({ title: 'Text inserted', subtitle: 'Here is the update', ok: true })
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('context action "Send message" prepares an agent intent', () => {
    c.setView({ kind: 'contextActions', sentence: 'Running late', actions: ['Insert text', 'Send message'] })
    fingers(2)
    expect(viewAs('agentReady')).toMatchObject({ intent: 'Send message: "Running late"', sentence: 'Running late' })
  })

  it('context action "More options" opens the quick menu for the sentence', () => {
    c.setView({ kind: 'contextActions', sentence: 'x', actions: ['More options'] })
    c.tap('option', 0)
    expect(getApp().view).toEqual({ kind: 'quickMenu', options: QUICK_MENU, fromSentence: true })
  })

  it('no intent and no actions still offers Insert text and More options', async () => {
    vi.spyOn(services, 'interpret').mockResolvedValue({ ok: true, value: intentResult({ sentence: 'Hmm' }) })
    signSentence(word('hmm'))
    g('thumbsUp')
    await settle()
    expect(getApp().view).toEqual({ kind: 'contextActions', sentence: 'Hmm', actions: ['Insert text', 'More options'] })
  })

  it('missing API key: notice + agentReady with the raw sentence', async () => {
    vi.spyOn(services, 'interpret').mockResolvedValue({
      ok: false,
      error: 'no key',
      missingKey: 'ANTHROPIC_API_KEY'
    })
    signSentence(...MEETING)
    g('thumbsUp')
    await settle()
    expect(getApp().notice).toBe('Add ANTHROPIC_API_KEY to .env')
    expect(getApp().view).toEqual({
      kind: 'agentReady',
      intent: 'Meeting tomorrow at 3 pm',
      variant: 'default',
      sentence: 'Meeting tomorrow at 3 pm'
    })
    await settle(5000)
    expect(getApp().notice).toBeNull()
  })

  it('a rejected interpret call does not leave the card thinking', async () => {
    vi.spyOn(services, 'interpret').mockRejectedValue(new Error('IPC failed'))
    signSentence(word('hello'))
    g('thumbsUp')
    await settle()
    expect(getApp().notice).toBe('IPC failed')
    expect(viewAs('agentReady')).toMatchObject({ intent: 'Hello', sentence: 'Hello' })
  })

  it('editing while thinking discards the stale interpretation', async () => {
    const interpret = vi.spyOn(services, 'interpret').mockImplementation(async (req) => {
      await new Promise((r) => setTimeout(r, 500))
      return { ok: true, value: intentResult({ sentence: req.sentence, intent: `Do: ${req.sentence}` }) }
    })
    signSentence(word('call'), word('mom'), word('now'))
    g('thumbsUp')
    g('swipeLeft') // "Call mom now" -> "Call mom" while the first interpretation is in flight
    await settle(600)
    expect(viewAs('sentence').sentence).toBe('Call mom')
    g('thumbsUp')
    await settle(600)
    expect(viewAs('agentReady').intent).toBe('Do: Call mom')
    expect(interpret).toHaveBeenCalledTimes(2)
  })

  it('a newer failed interpretation is not masked by an older one', async () => {
    let call = 0
    vi.spyOn(services, 'interpret').mockImplementation(async () => {
      call++
      if (call === 1) {
        await new Promise((r) => setTimeout(r, 1000))
        return { ok: false, error: 'old failure' }
      }
      return { ok: true, value: intentResult({ intent: 'Call mom' }) }
    })
    signSentence(word('call'), word('mom'), word('now'))
    g('swipeLeft')
    g('thumbsUp')
    await settle(1000)
    expect(viewAs('agentReady').intent).toBe('Call mom')
    expect(getApp().notice).toBeNull()
  })

  it('the pencil edit replaces the phrase and re-interprets', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    signSentence(word('meeting'))
    c.editSentence('  Email the team  ')
    expect(getApp().view).toEqual({
      kind: 'sentence',
      sentence: 'Email the team',
      tokens: [word('Email'), word('the'), word('team')]
    })
    await settle()
    expect(interpret).toHaveBeenLastCalledWith(
      expect.objectContaining({ sentence: 'Email the team' }),
      expect.any(Function), // the call's status listener
      expect.any(AbortSignal) // aborted once the card drops the call
    )
    c.editSentence('   ')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('quick menu pick sets an intent prefix that reaches interpret', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    g('thumbsUp')
    expect(getApp().view).toEqual({ kind: 'quickMenu', options: QUICK_MENU })
    fingers(1)
    expect(getApp().view).toEqual({ kind: 'ready', hint: 'Create event: sign the details' })
    signSentence(...MEETING)
    await settle()
    expect(interpret.mock.calls[0][0].intentPrefix).toBe('Create event')
  })

  it('cancelling the quick menu clears the prefix', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    g('thumbsUp')
    fingers(2)
    sign(word('hi'))
    g('fist')
    signSentence(word('hi'))
    await settle()
    expect(interpret.mock.calls[0][0].intentPrefix).toBeUndefined()
  })

  it('without Claude, a quick-menu pick still reaches the agent with the details', async () => {
    vi.spyOn(services, 'interpret').mockResolvedValue({ ok: false, error: "Can't reach Claude. Check your connection" })
    g('thumbsUp')
    fingers(1)
    signSentence(word('lunch'), word('friday'))
    g('thumbsUp')
    await settle()
    expect(getApp().notice).toBe("Can't reach Claude. Check your connection")
    expect(viewAs('agentReady')).toMatchObject({ intent: 'Create event: Lunch friday', sentence: 'Lunch friday' })
  })

  it('without Claude, More options › a pick keeps the action', async () => {
    vi.spyOn(services, 'interpret')
      .mockResolvedValueOnce({ ok: true, value: intentResult({ sentence: 'Thank you for the update.' }) })
      .mockResolvedValueOnce({ ok: false, error: "Can't reach Claude. Check your connection" })
    signSentence(word('thank'), word('you'), word('update'))
    g('thumbsUp')
    await settle()
    fingers(2) // More options
    fingers(3) // Search web
    await settle()
    expect(viewAs('agentReady')).toMatchObject({ intent: 'Search web: Thank you update', sentence: 'Thank you update' })
  })
})

/** Routing of real-shaped Claude replies (as sanitizeIntent returns them in command mode). */
describe('intent routing', () => {
  const answer = (value: IntentResult): void => {
    vi.spyOn(services, 'interpret').mockResolvedValue({ ok: true, value })
  }
  const proceedWith = async (...tokens: Token[]): Promise<void> => {
    signSentence(...tokens)
    g('thumbsUp')
    await settle()
  }

  it('a confident intent goes straight to Agent ready; its alternatives are not asked', async () => {
    answer({
      sentence: 'Play Motion Sickness.',
      intent: 'Play Motion Sickness by Phoebe Bridgers on Spotify',
      alternatives: ['Search Spotify for Motion Sickness'],
      confidence: 0.92,
      needs_confirmation: false,
      context_actions: ['More options']
    })
    await proceedWith(word('play'), word('motion'), word('sickness'))
    expect(getApp().view).toEqual({
      kind: 'agentReady',
      intent: 'Play Motion Sickness by Phoebe Bridgers on Spotify',
      variant: 'default',
      target: undefined,
      sentence: 'Play Motion Sickness.'
    })
  })

  it('close alternatives ask "Did you mean" even above 0.6; fingers pick one for Agent ready', async () => {
    answer({
      sentence: 'Meeting tomorrow at 3.',
      intent: 'Create a calendar event called Meeting tomorrow at 3 PM',
      alternatives: ['Remind me about the meeting tomorrow at 3 PM', 'Show my calendar for tomorrow'],
      confidence: 0.7,
      needs_confirmation: true,
      context_actions: ['Insert text', 'More options']
    })
    await proceedWith(word('meeting'), word('tomorrow'), word('time'), word('3'))
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
      variant: 'list',
      options: [
        'Create a calendar event called Meeting tomorrow at 3 PM',
        'Remind me about the meeting tomorrow at 3 PM',
        'Show my calendar for tomorrow'
      ],
      purpose: 'intent',
      quote: 'Meeting tomorrow at 3.'
    })
    expect(activeGestures(getApp().view).has('fingers')).toBe(true)
    fingers(2)
    expect(getApp().view).toEqual({
      kind: 'agentReady',
      intent: 'Remind me about the meeting tomorrow at 3 PM',
      variant: 'default',
      sentence: 'Meeting tomorrow at 3.'
    })
  })

  it('a lone low-confidence intent is shown as one numbered row; a pick opens Agent ready, never the agent', async () => {
    const run = vi.spyOn(services, 'agentRun')
    answer({
      sentence: 'Friend music.',
      intent: 'Play the Friends playlist on Spotify',
      alternatives: [],
      confidence: 0.45,
      needs_confirmation: false,
      context_actions: ['More options']
    })
    await proceedWith(word('friend'), word('music'))
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
      variant: 'list',
      options: ['Play the Friends playlist on Spotify'],
      purpose: 'intent',
      quote: 'Friend music.'
    })
    g('thumbsUp')
    expect(getApp().view).toEqual({
      kind: 'agentReady',
      intent: 'Play the Friends playlist on Spotify',
      variant: 'default',
      sentence: 'Friend music.'
    })
    await settle()
    expect(run).not.toHaveBeenCalled()
  })

  it('no intent at low confidence lists the candidate intents, then Insert text', async () => {
    answer({
      sentence: 'Friend music.',
      intent: null,
      alternatives: ['Play music', 'Text a friend', 'Open Music'],
      confidence: 0.35,
      needs_confirmation: false,
      context_actions: ['More options']
    })
    await proceedWith(word('friend'), word('music'))
    expect(viewAs('didYouMean')).toMatchObject({
      variant: 'list',
      options: ['Play music', 'Text a friend', 'Open Music', 'Insert text'],
      purpose: 'intent'
    })
  })

  it('text Claude is unsure about can still be inserted, or edited with a swipe left', async () => {
    const typeText = vi.spyOn(services, 'typeText')
    answer({
      sentence: 'Thank you for the update.',
      intent: null,
      alternatives: ['Reply "Thank you for the update" to this email'],
      confidence: 0.55,
      needs_confirmation: false,
      context_actions: ['Insert text', 'Reply']
    })
    await proceedWith(word('thank'), word('you'), word('update'))
    expect(viewAs('didYouMean').options).toEqual(['Reply "Thank you for the update" to this email', 'Insert text'])
    g('swipeLeft')
    expect(viewAs('sentence')).toMatchObject({ sentence: 'Thank you update', tokens: [word('thank'), word('you'), word('update')] })
    g('thumbsUp')
    await settle()
    fingers(2)
    await settle()
    expect(typeText).toHaveBeenCalledWith('Thank you for the update.')
    expect(viewAs('toast').title).toBe('Text inserted')
  })

  it('Insert text and More options are offered whatever actions Claude suggests', async () => {
    answer({
      sentence: 'Pasta recipes.',
      intent: null,
      alternatives: [],
      confidence: 0.8,
      needs_confirmation: false,
      context_actions: ['Search web', 'Copy', 'Translate']
    })
    await proceedWith(word('pasta'), word('recipes'))
    expect(viewAs('contextActions').actions).toEqual(['Insert text', 'Search web', 'Copy', 'More options'])
    fingers(4)
    expect(getApp().view).toEqual({ kind: 'quickMenu', options: QUICK_MENU, fromSentence: true })
  })

  it('text to type (no intent, confident) shows the context actions, ignoring alternatives', async () => {
    answer({
      sentence: 'Thank you for the update!',
      intent: null,
      alternatives: ['Reply "Thank you for the update!" to this email'],
      confidence: 0.88,
      needs_confirmation: false,
      context_actions: ['Insert text', 'Send message', 'More options']
    })
    await proceedWith(word('thank'), word('you'), word('update'))
    expect(getApp().view).toEqual({
      kind: 'contextActions',
      sentence: 'Thank you for the update!',
      actions: ['Insert text', 'Send message', 'More options']
    })
    expect([...activeGestures(getApp().view)].sort()).toEqual(['fingers', 'fist'])
  })

  it('a failed insert says why and stays, so it can be picked again once fixed', async () => {
    const error = 'Allow fastASL in System Settings › Privacy & Security › Accessibility'
    const typeText = vi.spyOn(services, 'typeText').mockResolvedValueOnce({ ok: false, error })
    const actions: View = { kind: 'contextActions', sentence: 'Thanks!', actions: ['Insert text', 'More options'] }
    c.setView(actions)
    fingers(1)
    await settle()
    expect(getApp().view).toBe(actions)
    expect(getApp().notice).toBe(error)
    fingers(1)
    await settle()
    expect(typeText).toHaveBeenCalledTimes(2)
    expect(viewAs('toast')).toMatchObject({ title: 'Text inserted', subtitle: 'Thanks!', ok: true })
  })

  it('a second pick while the text is still being typed does not type it twice', async () => {
    let finish: (res: { ok: true; value: undefined }) => void = () => {}
    const typeText = vi
      .spyOn(services, 'typeText')
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    c.setView({ kind: 'contextActions', sentence: 'Thanks!', actions: ['Insert text', 'More options'] })
    fingers(1)
    fingers(1)
    expect(typeText).toHaveBeenCalledTimes(1)
    expect(getApp().notice).toBe('Still typing the last pick')
    finish({ ok: true, value: undefined })
    await settle()
    expect(viewAs('toast').title).toBe('Text inserted')
  })

  it('More options › a quick-menu pick interprets the signed sentence with that prefix', async () => {
    const interpret = vi
      .spyOn(services, 'interpret')
      .mockResolvedValueOnce({
        ok: true,
        value: intentResult({ sentence: 'Team lunch Friday at noon.', context_actions: ['Insert text', 'More options'] })
      })
      .mockResolvedValueOnce({
        ok: true,
        value: intentResult({
          sentence: 'Team lunch Friday at noon.',
          intent: 'Create a calendar event called Team lunch on Friday at 12 PM',
          confidence: 0.9,
          needs_confirmation: true
        })
      })
    await proceedWith(word('team'), word('lunch'), word('friday'), word('noon'))
    fingers(2)
    expect(getApp().view).toEqual({ kind: 'quickMenu', options: QUICK_MENU, fromSentence: true })
    fingers(1)
    expect(viewAs('sentence')).toMatchObject({ sentence: 'Team lunch friday noon', thinking: true })
    await settle()
    expect(interpret).toHaveBeenCalledTimes(2)
    expect(interpret.mock.calls[1][0]).toMatchObject({
      tokens: ['team', 'lunch', 'friday', 'noon'],
      intentPrefix: 'Create event',
      mode: 'command'
    })
    expect(viewAs('agentReady').intent).toBe('Create a calendar event called Team lunch on Friday at 12 PM')
  })

  it('Claude without a key: notice, Agent ready with the raw sentence, then the agent is not available yet', async () => {
    vi.spyOn(services, 'interpret').mockResolvedValue({
      ok: false,
      error: 'Add ANTHROPIC_API_KEY to .env',
      missingKey: 'ANTHROPIC_API_KEY'
    })
    vi.spyOn(services, 'agentRun').mockResolvedValue({ ok: false, error: 'The agent is not available yet' })
    await proceedWith(word('open'), word('notes'))
    expect(getApp().notice).toBe('Add ANTHROPIC_API_KEY to .env')
    expect(viewAs('agentReady')).toMatchObject({ intent: 'Open notes', sentence: 'Open notes' })
    g('thumbsUp')
    await settle()
    expect(viewAs('done')).toMatchObject({
      ok: false,
      title: "Couldn't start the agent",
      subtitle: 'The agent is not available yet'
    })
  })

  it('a wrong key is reported as is, not as a missing key', async () => {
    vi.spyOn(services, 'interpret').mockResolvedValue({ ok: false, error: 'Claude rejected ANTHROPIC_API_KEY. Check .env' })
    await proceedWith(word('hello'))
    expect(getApp().notice).toBe('Claude rejected ANTHROPIC_API_KEY. Check .env')
    expect(viewAs('agentReady').intent).toBe('Hello')
  })
})

describe('agent run', () => {
  it('agentReady --thumbsUp--> working, steps stream, confirm, approve, done, auto-collapse', async () => {
    const run = vi.spyOn(services, 'agentRun')
    const ready = await toAgentReady()
    g('thumbsUp')
    expect(getApp().view).toEqual({ kind: 'working', intent: ready.intent, steps: [] })
    await settle()
    expect(run).toHaveBeenCalledWith({
      intent: ready.intent,
      sentence: ready.sentence,
      frontmost: { name: 'Mail', windowTitle: 'New Message' }
    })
    expect(viewAs('working').steps).toEqual([{ id: 's0', label: 'Opening Calendar', status: 'current' }])

    await settle(700)
    expect(viewAs('working').steps.map((s) => s.status)).toEqual(['done', 'current'])

    await settle(700)
    expect(viewAs('confirm').details).toMatchObject({ kind: 'event', title: 'Team Sync' })

    g('thumbsUp')
    expect(viewAs('working').steps.map((s) => s.status)).toEqual(['done', 'current'])
    await settle()
    expect(viewAs('working').steps.map((s) => s.status)).toEqual(['done', 'done', 'current'])

    await settle(1400)
    expect(getApp().view).toEqual({
      kind: 'done',
      ok: true,
      title: 'Meeting created',
      subtitle: 'Tomorrow at 10:00 AM with 4 guests.',
      view: { kind: 'openApp', app: 'Calendar' },
      intent: ready.intent
    })

    await settle(DONE_AUTO_COLLAPSE_MS - 1)
    expect(getApp().view.kind).toBe('done')
    await settle(1)
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('confirm --fist--> denied: the agent cancels', async () => {
    const respond = vi.spyOn(services, 'agentRespond')
    await toAgentReady()
    g('thumbsUp')
    await settle(1400)
    const confirm = viewAs('confirm')
    g('fist')
    expect(viewAs('working').intent).toBe('Schedule a meeting tomorrow at 3pm with the team')
    await settle()
    expect(respond).toHaveBeenCalledWith(confirm.requestId, false)
    expect(viewAs('done')).toMatchObject({ ok: false, title: 'Nothing was done', subtitle: 'You cancelled it' })
    // A failed result stays twice as long before collapsing.
    await settle(DONE_AUTO_COLLAPSE_MS)
    viewAs('done')
    await settle(DONE_AUTO_COLLAPSE_MS)
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('confirm buttons: primary approves, close denies', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    const details = { kind: 'generic' as const, title: 'Delete file', lines: [] }
    c.setView({ kind: 'agentReady', intent: 'Tidy up', variant: 'default', sentence: 'Tidy up' })
    c.tap('primary')
    await settle()
    emit({ type: 'confirm', runId: 'r1', requestId: 'q1', tool: 'rm', details })
    c.tap('primary')
    expect(manual.agentRespond).toHaveBeenLastCalledWith('q1', true)
    emit({ type: 'confirm', runId: 'r1', requestId: 'q2', tool: 'rm', details })
    c.tap('close')
    expect(manual.agentRespond).toHaveBeenLastCalledWith('q2', false)
    expect(viewAs('working').intent).toBe('Tidy up')
  })

  it('confirm returns to the live step list', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    c.setView({ kind: 'agentReady', intent: 'Tidy up', variant: 'default', sentence: 'Tidy up' })
    g('thumbsUp')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Look', status: 'current' } })
    emit({ type: 'confirm', runId: 'r1', requestId: 'q1', tool: 'rm', details: { kind: 'generic', title: 't', lines: [] } })
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Look', status: 'done' } })
    g('thumbsUp')
    expect(viewAs('working').steps).toEqual([{ id: 'a', label: 'Look', status: 'done' }])
  })

  it('working --fist--> stops the agent, toasts, then returns to a fresh ready', async () => {
    const stop = vi.spyOn(services, 'agentStop')
    await toAgentReady()
    g('thumbsUp')
    await settle(700)
    g('fist')
    await settle()
    expect(stop).toHaveBeenCalled()
    expect(getApp().view).toEqual({
      kind: 'toast',
      title: 'Stopped',
      subtitle: 'The agent was interrupted',
      ok: false,
      meta: undefined,
      returnTo: 'ready'
    })
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'ready' })
    await settle(10_000)
    expect(getApp().view).toEqual({ kind: 'ready' })
    // The stopped phrase is gone: a new sign starts a new phrase.
    c.token(word('hi'))
    expect(viewAs('recognizing').token).toBe('hi')
  })

  it('the close button stops a working agent', async () => {
    const stop = vi.spyOn(services, 'agentStop')
    c.setView({ kind: 'agentReady', intent: 'x', variant: 'default', sentence: 'x' })
    g('thumbsUp')
    await settle()
    c.tap('close')
    await settle()
    expect(stop).toHaveBeenCalled()
    expect(viewAs('toast').title).toBe('Stopped')
  })

  it('stopping after a quick-menu command forgets its prefix', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    g('thumbsUp')
    fingers(1)
    signSentence(...MEETING)
    g('thumbsUp')
    await settle(500)
    g('thumbsUp')
    await settle()
    g('fist')
    await settle(TOAST_MS)
    signSentence(word('hi'))
    await settle()
    expect(interpret.mock.calls.map((call) => call[0].intentPrefix)).toEqual(['Create event', undefined])
  })

  it('ignores agent events that arrive after a stop', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    c.setView({ kind: 'agentReady', intent: 'Play music', variant: 'default', sentence: 'Play music' })
    g('thumbsUp')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Opening Spotify', status: 'current' } })
    expect(viewAs('working').steps).toHaveLength(1)
    g('fist')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Opening Spotify', status: 'done' } })
    emit({ type: 'error', runId: 'r1', message: 'Interrupted' })
    emit({ type: 'confirm', runId: 'r1', requestId: 'late', tool: 'x', details: { kind: 'generic', title: 't', lines: [] } })
    expect(viewAs('toast').title).toBe('Stopped')
    // A late confirmation request is denied so the agent never waits forever.
    expect(manual.agentRespond).toHaveBeenCalledWith('late', false)
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('a stopped run that had already sent something says so instead of "Stopped"', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    c.setView({ kind: 'agentReady', intent: 'Text Mom on my way', variant: 'default', sentence: 'Text Mom on my way' })
    g('thumbsUp')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'm', label: 'Messaging Mom', status: 'current' } })
    g('fist')
    expect(viewAs('toast')).toMatchObject({ title: 'Stopped', subtitle: 'The agent was interrupted' })
    // The send was already running: main reports it once it lands.
    const sent = [{ tool: 'message_send', args: {}, ok: true }]
    emit({ type: 'done', runId: 'r1', result: { title: 'Message sent', subtitle: 'You stopped the rest', evidence: sent }, complete: false })
    expect(viewAs('toast')).toMatchObject({ ok: false, title: 'Message sent', subtitle: 'You stopped the rest', returnTo: 'ready' })
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'ready' })

    // Once the card has moved on, the report is a notice.
    c.setView({ kind: 'agentReady', intent: 'Email Sam hi', variant: 'default', sentence: 'Email Sam hi' })
    g('thumbsUp')
    await settle()
    g('fist')
    await settle(TOAST_MS)
    signSentence(word('hi'))
    emit({ type: 'done', runId: 'r1', result: { title: 'Email sent', subtitle: 'You stopped the rest', evidence: sent }, complete: false })
    expect(getApp().notice).toBe('Email sent before you stopped')
    expect(getApp().view.kind).not.toBe('toast')
  })

  it('a stop before the agent starts never launches it', async () => {
    const run = vi.spyOn(services, 'agentRun')
    c.setView({ kind: 'agentReady', intent: 'x', variant: 'default', sentence: 'x' })
    g('thumbsUp')
    g('fist') // same frame, before frontmostApp() resolved
    await settle()
    expect(run).not.toHaveBeenCalled()
    expect(viewAs('toast').title).toBe('Stopped')
  })

  it('an agent that stops on its own shows the stopped toast', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    c.setView({ kind: 'agentReady', intent: 'x', variant: 'default', sentence: 'x' })
    g('thumbsUp')
    await settle()
    emit({ type: 'stopped', runId: 'r1' })
    expect(viewAs('toast')).toMatchObject({ title: 'Stopped', returnTo: 'ready' })
  })

  it('a failed start shows a failed done card with the missing key', async () => {
    vi.spyOn(services, 'agentRun').mockResolvedValue({ ok: false, error: 'nope', missingKey: 'FACTORY_API_KEY' })
    c.setView({ kind: 'agentReady', intent: 'x', variant: 'default', sentence: 'x' })
    g('thumbsUp')
    await settle()
    expect(viewAs('done')).toMatchObject({ ok: false, title: "Couldn't start the agent", subtitle: 'Add FACTORY_API_KEY to .env' })
    await settle(DONE_AUTO_COLLAPSE_MS * 2)
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('a rejected start does not leave the card stuck on working', async () => {
    vi.spyOn(services, 'agentRun').mockRejectedValue(new Error('main crashed'))
    c.setView({ kind: 'agentReady', intent: 'x', variant: 'default', sentence: 'x' })
    g('thumbsUp')
    await settle()
    expect(viewAs('done')).toMatchObject({ ok: false, subtitle: 'main crashed' })
  })

  it('an error event ends the run', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    c.setView({ kind: 'agentReady', intent: 'Play music', variant: 'default', sentence: 'Play music' })
    g('thumbsUp')
    await settle()
    emit({ type: 'error', runId: 'r1', message: 'Spotify is not running' })
    expect(viewAs('done')).toMatchObject({ ok: false, title: "Couldn't finish", subtitle: 'Spotify is not running', intent: 'Play music' })
    emit({ type: 'error', runId: 'r1', message: 'x', missingKey: 'SPOTIFY_CLIENT_ID' })
    expect(viewAs('done').subtitle).toBe('Spotify is not running')
  })

  it('an unfinished task is not ok, even with successful evidence; a complete one is, despite a failed retry', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    c.setView({ kind: 'agentReady', intent: 'Text Mom hi', variant: 'default', sentence: 'Text Mom hi' })
    g('thumbsUp')
    await settle()
    const sent = [{ tool: 'message_send', args: {}, ok: true }]
    emit({ type: 'done', runId: 'r1', result: { title: 'Message sent', subtitle: 'Droid process exited', evidence: sent }, complete: false })
    expect(viewAs('done')).toMatchObject({ ok: false, title: 'Message sent', subtitle: 'Droid process exited' })
    await settle(DONE_AUTO_COLLAPSE_MS)
    viewAs('done') // failures stay twice as long
    // Not a completed task: 3 fingers don't save it, and New gesture doesn't suggest it.
    expect(optionsFor(getApp().view)).toEqual(['View', 'New command'])
    fingers(3)
    await settle()
    viewAs('done')
    c.startNewGesture()
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Open Notes'] })

    c.setView({ kind: 'agentReady', intent: 'Play jazz', variant: 'default', sentence: 'Play jazz' })
    g('thumbsUp')
    await settle()
    const retried = [{ tool: 'spotify_play', args: {}, ok: false }, { tool: 'spotify_play', args: {}, ok: true }]
    emit({ type: 'done', runId: 'r1', result: { title: 'Playing jazz', subtitle: '', evidence: retried }, complete: true })
    expect(viewAs('done').ok).toBe(true)
    fingers(3)
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Play jazz', 'Open Notes'] })
  })

  it('holds events until agentRun replies with the run id, then shows only that run\'s', async () => {
    const { services: manual, emit } = manualAgent(services)
    let reply: (value: { ok: true; value: { runId: string } }) => void = () => {}
    vi.mocked(manual.agentRun).mockImplementation(() => new Promise((resolve) => (reply = resolve)))
    useServices(manual)
    c.setView({ kind: 'agentReady', intent: 'x', variant: 'default', sentence: 'x' })
    g('thumbsUp')
    await settle()
    // The previous run's stop and this run's start arrive before the reply: nothing shows yet.
    emit({ type: 'stopped', runId: 'old' })
    emit({ type: 'started', runId: 'r2', intent: 'x' })
    emit({ type: 'step', runId: 'r2', step: { id: 'a', label: 'Thinking', status: 'current' } })
    emit({ type: 'step', runId: 'old', step: { id: 'b', label: 'Old step', status: 'current' } })
    emit({ type: 'confirm', runId: 'old', requestId: 'stale', tool: 'x', details: { kind: 'generic', title: 't', lines: [] } })
    expect(viewAs('working').steps).toEqual([])
    reply({ ok: true, value: { runId: 'r2' } })
    await settle()
    expect(viewAs('working').steps).toEqual([{ id: 'a', label: 'Thinking', status: 'current' }])
    expect(manual.agentRespond).toHaveBeenCalledWith('stale', false)
    emit({ type: 'done', runId: 'r2', result: { title: 'Opened', subtitle: '', evidence: [] }, complete: true })
    expect(viewAs('done').title).toBe('Opened')
  })

  it('a failed start drops the events it held, declining their confirms', async () => {
    const { services: manual, emit } = manualAgent(services)
    let reply: (value: { ok: false; error: string }) => void = () => {}
    vi.mocked(manual.agentRun).mockImplementation(() => new Promise((resolve) => (reply = resolve)))
    useServices(manual)
    c.setView({ kind: 'agentReady', intent: 'x', variant: 'default', sentence: 'x' })
    g('thumbsUp')
    await settle()
    emit({ type: 'started', runId: 'old', intent: 'y' })
    emit({ type: 'confirm', runId: 'old', requestId: 'stale', tool: 'x', details: { kind: 'generic', title: 't', lines: [] } })
    reply({ ok: false, error: 'nope' })
    await settle()
    expect(viewAs('done')).toMatchObject({ ok: false, title: "Couldn't start the agent", subtitle: 'nope' })
    expect(manual.agentRespond).toHaveBeenCalledWith('stale', false)
  })

  it('still receives agent events after dispose() (React StrictMode remounts App)', async () => {
    c.dispose()
    c.setView({ kind: 'agentReady', intent: 'x', variant: 'default', sentence: 'x' })
    g('thumbsUp')
    await settle()
    expect(viewAs('working').steps).toHaveLength(1)
  })

  it('agentReady swipeLeft goes back to the sentence; fist cancels', async () => {
    await toAgentReady()
    g('swipeLeft')
    expect(viewAs('sentence')).toMatchObject({ sentence: 'Meeting tomorrow at 3 pm', tokens: MEETING })
    g('thumbsUp')
    await settle(500)
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('agentReady secondary button changes the sentence', async () => {
    await toAgentReady()
    c.tap('secondary')
    expect(viewAs('sentence').sentence).toBe('Meeting tomorrow at 3 pm')
  })

  it('done: 1 opens the result, 2 starts over, 3 saves as a gesture', async () => {
    const open = vi.spyOn(services, 'openTarget')
    const done: View = {
      kind: 'done',
      ok: true,
      title: 'Meeting created',
      subtitle: '',
      view: { kind: 'openApp', app: 'Calendar' },
      intent: 'Schedule a meeting'
    }
    c.setView(done)
    fingers(1)
    expect(open).toHaveBeenCalledWith({ kind: 'openApp', app: 'Calendar' })
    fingers(2)
    expect(getApp().view).toEqual({ kind: 'ready' })

    c.setView(done)
    fingers(3)
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Schedule a meeting', 'Open Notes'] })

    c.setView(done)
    g('thumbsUp')
    expect(getApp().view).toEqual({ kind: 'ready' })
    c.setView(done)
    g('swipeUp')
    expect(viewAs('settings').settings).toEqual({ page: 'root' })
    c.setView(done)
    g('fist')
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('done buttons: primary starts over, secondary opens the result', () => {
    const open = vi.spyOn(services, 'openTarget')
    c.setView({ kind: 'done', ok: true, title: 't', subtitle: '', view: { kind: 'openUrl', url: 'https://x.dev' } })
    c.tap('secondary')
    expect(open).toHaveBeenCalledWith({ kind: 'openUrl', url: 'https://x.dev' })
    c.tap('primary')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  describe('a failed start uses up the phrase', () => {
    const failedStart = async (): Promise<void> => {
      vi.spyOn(services, 'agentRun').mockResolvedValue({ ok: false, error: 'The agent is not available yet' })
      g('thumbsUp')
      fingers(1) // Create event: sign the details
      signSentence(word('meeting'), word('tomorrow'))
      g('thumbsUp')
      await settle(500)
      g('thumbsUp')
      await settle()
      expect(viewAs('done').title).toBe("Couldn't start the agent")
      g('swipeUp')
      g('fist')
      expect(getApp().view).toEqual({ kind: 'ready' })
    }

    it('failed start › settings › back › sign begins a new sentence', async () => {
      await failedStart()
      signSentence(word('hello'))
      expect(viewAs('sentence').sentence).toBe('Hello')
    })

    it('failed start › settings › back › a quick-menu pick waits for its details', async () => {
      const interpret = vi.spyOn(services, 'interpret')
      await failedStart()
      interpret.mockClear()
      g('thumbsUp')
      fingers(1)
      expect(getApp().view).toEqual({ kind: 'ready', hint: 'Create event: sign the details' })
      expect(interpret).not.toHaveBeenCalled()
    })
  })
})

describe('did you mean', () => {
  it('ambiguous sign: pick by fingers appends the chosen word', () => {
    c.token(word('meeting'))
    c.ambiguousSign(['tomorrow', 'today', 'tonight', 'Tuesday'])
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
      variant: 'list',
      options: ['tomorrow', 'today', 'tonight'],
      purpose: 'sign'
    })
    c.token(word('ignored'))
    fingers(4)
    expect(getApp().view.kind).toBe('didYouMean')
    fingers(2)
    expect(viewAs('building')).toMatchObject({ tokens: [word('meeting'), word('today')], current: 'today', sentence: 'Meeting today' })
  })

  it('thumbsUp takes the first option', () => {
    c.ambiguousSign(['hello', 'help'])
    g('thumbsUp')
    expect(viewAs('building')).toMatchObject({ tokens: [word('hello')] })
  })

  it('ambiguous sign on the Sentence card: asks, and the pick continues the phrase', () => {
    signSentence(word('meeting'), word('tomorrow'))
    c.ambiguousSign(['at', 'and'])
    expect(viewAs('didYouMean').options).toEqual(['at', 'and'])
    fingers(1)
    expect(viewAs('building')).toMatchObject({ sentence: 'Meeting tomorrow at' })
  })

  it('"Edit" on an ambiguous sign returns to the phrase', () => {
    sign(word('meeting'), word('at'))
    c.ambiguousSign(['three', 'tree'])
    c.tap('secondary')
    expect(viewAs('building')).toMatchObject({ tokens: [word('meeting'), word('at')], sentence: 'Meeting at' })
  })

  it('quote variant: "Yes, send" shows the intent on Agent ready before it runs', () => {
    c.setView({
      kind: 'didYouMean',
      variant: 'quote',
      quote: 'Meeting tomorrow at 3pm',
      options: ['Send "Meeting tomorrow at 3pm"'],
      purpose: 'intent'
    })
    c.tap('primary')
    expect(getApp().view).toEqual({
      kind: 'agentReady',
      intent: 'Send "Meeting tomorrow at 3pm"',
      variant: 'default',
      sentence: 'Meeting tomorrow at 3pm'
    })
  })

  it('quote variant: swipeLeft edits, fist cancels', () => {
    sign(word('meeting'), word('tomorrow'))
    c.setView({ kind: 'didYouMean', variant: 'quote', quote: 'Meeting tomorrow', options: ['Send it'], purpose: 'intent' })
    g('swipeLeft')
    expect(viewAs('sentence').sentence).toBe('Meeting tomorrow')
    c.setView({ kind: 'didYouMean', variant: 'quote', quote: 'Meeting tomorrow', options: ['Send it'], purpose: 'intent' })
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })
})

describe('spell mode', () => {
  beforeEach(() => setApp({ mode: 'spell' }))

  it('end of phrase offers the letters at once, then the spellings; picking one types it, then toasts', async () => {
    const typeText = vi.spyOn(services, 'typeText')
    sign(letter('K'), letter('C'))
    expect(viewAs('building').sentence).toBe('KC')
    g('handsDown')
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
      variant: 'list',
      options: ['KC'],
      purpose: 'spell',
      quote: 'KC',
      pending: true
    })
    await settle(300)
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
      variant: 'list',
      options: ['KC', 'kc', 'kc@calhacks.io'],
      purpose: 'spell',
      quote: 'KC'
    })
    fingers(3)
    await settle()
    expect(typeText).toHaveBeenCalledWith('kc@calhacks.io')
    expect(viewAs('toast')).toMatchObject({ title: 'Typed', subtitle: 'kc@calhacks.io', ok: true, returnTo: 'ready' })
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().mode).toBe('spell')
    c.token(letter('A'))
    expect(viewAs('recognizing').token).toBe('A')
  })

  it.each(['thumbsUp', 'swipeRight'] as const)('%s also ends the spelling', async (gesture) => {
    const spellSuggest = vi.spyOn(services, 'spellSuggest')
    sign(letter('K'), letter('C'))
    g(gesture)
    expect(viewAs('didYouMean')).toMatchObject({ purpose: 'spell', options: ['KC'] })
    await settle()
    expect(spellSuggest).toHaveBeenCalledWith(
      { letters: 'KC', frontmost: { name: 'Mail', windowTitle: 'New Message' } },
      expect.any(Function), // the call's status listener
      expect.any(AbortSignal) // aborted once the card drops the call
    )
  })

  it('the raw letters can be typed before the spellings arrive, which are then dropped', async () => {
    let typed: (res: { ok: true; value: undefined }) => void = () => {}
    const typeText = vi.spyOn(services, 'typeText').mockReturnValueOnce(new Promise((resolve) => (typed = resolve)))
    sign(letter('K'), letter('C'))
    g('handsDown')
    fingers(2) // nothing to pick yet
    expect(viewAs('didYouMean').pending).toBe(true)
    g('thumbsUp')
    expect(typeText).toHaveBeenCalledWith('KC')
    expect(viewAs('didYouMean')).toMatchObject({ options: ['KC'], pending: false })
    await settle(300) // the spellings arrive while the letters are still being pasted
    expect(viewAs('didYouMean').options).toEqual(['KC'])
    typed({ ok: true, value: undefined })
    await settle()
    expect(viewAs('toast').subtitle).toBe('KC')
  })

  it('falls back to the raw letters when suggestions fail', async () => {
    vi.spyOn(services, 'spellSuggest').mockResolvedValue({ ok: false, error: 'x', missingKey: 'ANTHROPIC_API_KEY' })
    sign(letter('K'), letter('C'))
    g('thumbsUp')
    await settle()
    expect(getApp().view).toEqual({ kind: 'didYouMean', variant: 'list', options: ['KC'], purpose: 'spell', quote: 'KC' })
    expect(getApp().notice).toBe('Add ANTHROPIC_API_KEY to .env')
  })

  it('suggestions that arrive after a cancel are dropped', async () => {
    sign(letter('K'), letter('C'))
    g('handsDown')
    g('fist')
    await settle(300)
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('swipe left takes back one letter, not the whole word', () => {
    sign(letter('K'), letter('C'), letter('X'))
    g('swipeLeft')
    expect(viewAs('building')).toMatchObject({ tokens: [letter('K'), letter('C')], sentence: 'KC' })
    g('swipeLeft')
    expect(viewAs('building').sentence).toBe('K')
    g('swipeLeft')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('"Edit" (swipe left or the button) on the spelling list goes back to the letters, not to the agent', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    sign(letter('K'), letter('C'))
    g('handsDown')
    await settle(300)
    g('swipeLeft')
    expect(viewAs('building')).toMatchObject({ tokens: [letter('K'), letter('C')], sentence: 'KC' })
    g('handsDown')
    await settle(300)
    c.tap('secondary')
    expect(viewAs('building').sentence).toBe('KC')
    expect(interpret).not.toHaveBeenCalled()
  })

  it('a spelling that cannot be typed stays on the list with the reason', async () => {
    const error = 'Allow fastASL in System Settings › Privacy & Security › Accessibility'
    vi.spyOn(services, 'typeText').mockResolvedValue({ ok: false, error })
    sign(letter('K'), letter('C'))
    g('handsDown')
    await settle(300)
    const list = viewAs('didYouMean')
    fingers(2)
    await settle()
    expect(getApp().view).toBe(list)
    expect(getApp().notice).toBe(error)
  })

  it('a paste that finishes after the card moved on only says so, keeping the new spelling', async () => {
    let typed: (res: { ok: true; value: undefined }) => void = () => {}
    const typeText = vi.spyOn(services, 'typeText').mockReturnValueOnce(new Promise((resolve) => (typed = resolve)))
    sign(letter('K'), letter('C'))
    g('handsDown')
    await settle(300)
    fingers(1) // waits on the Automation prompt
    g('fist')
    sign(letter('A'), letter('B'))
    g('handsDown')
    fingers(1)
    expect(getApp().notice).toBe('Still typing the last pick')
    expect(typeText).toHaveBeenCalledTimes(1)
    await settle(300) // the new list still gets its spellings
    const list = viewAs('didYouMean')
    expect(list.options).toEqual(['AB', 'ab', 'ab@calhacks.io'])
    typed({ ok: true, value: undefined })
    await settle()
    expect(getApp().view).toBe(list)
    expect(getApp().notice).toBe('Typed: “KC”')
    await settle(TOAST_MS)
    expect(getApp().view).toBe(list)
    fingers(1)
    await settle()
    expect(typeText).toHaveBeenLastCalledWith(' AB') // right after KC
    expect(viewAs('toast').subtitle).toBe('AB')
  })

  it('a thumbs-up in Ready opens no quick menu (Spell mode has no commands to prefix)', () => {
    expect(activeGestures({ kind: 'ready' }, 'spell').has('thumbsUp')).toBe(false)
    expect(activeGestures({ kind: 'recognizing', token: null, isWord: false }, 'spell').has('thumbsUp')).toBe(false)
    g('thumbsUp')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })
})

describe('dictation mode', () => {
  beforeEach(() => {
    setApp({ mode: 'dictation' })
    c.setView({ kind: 'dictation', text: '' })
  })

  it('types each sign at the cursor: no space before the first, words spaced, letter runs joined', () => {
    const typeText = vi.spyOn(services, 'typeText')
    sign(word('hello'), letter('A'), letter('B'), word('world'), word('again'))
    expect(typeText.mock.calls.map((call) => call[0])).toEqual(['hello', ' A', 'B', ' world', ' again'])
    expect(getApp().view).toEqual({ kind: 'dictation', text: 'hello AB world again' })
  })

  it('a spelled word first starts without a space too', () => {
    const typeText = vi.spyOn(services, 'typeText')
    sign(letter('K'), letter('C'), word('here'))
    expect(typeText.mock.calls.map((call) => call[0])).toEqual(['K', 'C', ' here'])
  })

  it('a cleared card starts a new run without a space', () => {
    const typeText = vi.spyOn(services, 'typeText')
    sign(word('hello'))
    c.tap('close') // the X next to the dictated text
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    sign(word('world'))
    expect(typeText.mock.calls.map((call) => call[0])).toEqual(['hello', 'world'])
  })

  it('Settings, a collapse or a mode switch keep the run going: the next word is spaced', () => {
    const typeText = vi.spyOn(services, 'typeText')
    sign(word('hello'))
    g('swipeUp')
    g('fist')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    sign(word('world'))
    c.collapse()
    c.expand()
    sign(letter('K'), letter('C'))
    g('swipeRight') // Spell
    g('swipeLeft') // and back
    sign(letter('X'))
    expect(typeText.mock.calls.map((call) => call[0])).toEqual(['hello', ' world', ' K', 'C', ' X'])
  })

  it('a spelling picked in Spell mode is spaced from the dictated words around it', async () => {
    const typeText = vi.spyOn(services, 'typeText')
    sign(word('my'), word('name'), word('is'))
    g('swipeRight')
    expect(getApp().mode).toBe('spell')
    sign(letter('K'), letter('C'))
    g('handsDown')
    await settle(300)
    fingers(1)
    await settle(TOAST_MS)
    g('swipeLeft')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    sign(word('hello'))
    expect(typeText.mock.calls.map((call) => call[0])).toEqual(['my', ' name', ' is', ' KC', ' hello'])
  })

  it('inserted text right after dictated words is spaced too', async () => {
    const typeText = vi.spyOn(services, 'typeText')
    sign(word('hello'))
    c.setView({ kind: 'contextActions', sentence: 'Thanks!', actions: ['Insert text', 'More options'] })
    fingers(1)
    await settle()
    expect(typeText).toHaveBeenLastCalledWith(' Thanks!')
    expect(viewAs('toast').subtitle).toBe('Thanks!')
  })

  it('a long pause off the card, or an agent run, starts a new run without a space', async () => {
    const typeText = vi.spyOn(services, 'typeText')
    sign(word('hello'))
    g('swipeUp')
    await settle(TYPED_RUN_MS)
    g('fist')
    sign(word('world'))
    await settle(TYPED_RUN_MS) // the card still shows the run, so it goes on
    sign(word('again'))
    void c.runAgent('Open Notes', 'Open Notes')
    c.setView({ kind: 'dictation', text: '' })
    sign(word('new'))
    expect(typeText.mock.calls.map((call) => call[0])).toEqual(['hello', 'world', ' again', 'new'])
  })

  it('never builds a phrase: no Listening, no Sentence, and hands down does nothing', () => {
    const interpret = vi.spyOn(services, 'interpret')
    c.signStart()
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    sign(word('hello'))
    g('handsDown')
    g('thumbsUp')
    c.phraseEnd()
    expect(getApp().view).toEqual({ kind: 'dictation', text: 'hello' })
    expect(interpret).not.toHaveBeenCalled()
  })

  it('types the best guess of an ambiguous sign instead of asking', () => {
    const typeText = vi.spyOn(services, 'typeText')
    c.ambiguousSign(['play', 'game'])
    expect(typeText).toHaveBeenCalledWith('play')
    expect(getApp().view).toEqual({ kind: 'dictation', text: 'play' })
  })

  it('keeps only the last 120 characters on the card', () => {
    for (let i = 0; i < 40; i++) c.token(word('word'))
    const text = viewAs('dictation').text
    expect(text).toHaveLength(120)
    expect(text.endsWith(' word')).toBe(true)
  })

  it('says why when typing fails (Accessibility), and keeps dictating', async () => {
    const error = 'Allow fastASL in System Settings › Privacy & Security › Accessibility'
    vi.spyOn(services, 'typeText').mockResolvedValue({ ok: false, error })
    sign(word('hello'))
    await settle()
    expect(getApp().notice).toBe(error)
    expect(getApp().view).toEqual({ kind: 'dictation', text: 'hello' })
    await settle(5000)
    expect(getApp().notice).toBe(error) // up long enough to read the path
    sign(word('world'))
    expect(getApp().view).toEqual({ kind: 'dictation', text: 'hello world' })
  })

  it('swipes switch modes, swipe up opens Settings and a fist goes back to Command', () => {
    g('swipeRight')
    expect(getApp().mode).toBe('spell')
    g('swipeLeft')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    g('swipeUp')
    expect(viewAs('settings').settings).toEqual({ page: 'root' })
    g('fist')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    vi.advanceTimersByTime(1000)
    g('fist')
    expect(getApp().mode).toBe('command')
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().modeFlashAt).toBe(performance.now()) // the header flashes "Command"
    expect(api.saveSettings).toHaveBeenLastCalledWith({ mode: 'command' })
  })
})

describe('dictationChunk', () => {
  it('spaces words and joins letters, never adding a trailing space', () => {
    expect(dictationChunk(null, word('hi'))).toBe('hi')
    expect(dictationChunk(null, letter('K'))).toBe('K')
    expect(dictationChunk('word', word('there'))).toBe(' there')
    expect(dictationChunk('word', letter('K'))).toBe(' K')
    expect(dictationChunk('letter', letter('C'))).toBe('C')
    expect(dictationChunk('letter', word('here'))).toBe(' here')
  })
})

describe('restoreMode (launch)', () => {
  it('shows the saved mode’s idle view without flashing it', () => {
    c.restoreMode('dictation')
    expect(getApp().mode).toBe('dictation')
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    expect(getApp().modeFlashAt).toBe(0)
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('a sign right after launch in Dictation is typed, not added to a phrase', () => {
    const typeText = vi.spyOn(services, 'typeText')
    c.restoreMode('dictation')
    c.signStart()
    c.token(word('hello'))
    expect(typeText).toHaveBeenCalledWith('hello')
    expect(getApp().view).toEqual({ kind: 'dictation', text: 'hello' })
  })

  it('leaves a card that is not idle alone', () => {
    c.collapse()
    c.restoreMode('spell')
    expect(getApp().mode).toBe('spell')
    expect(getApp().view).toEqual({ kind: 'collapsed' })
    c.expand()
    expect(getApp().view).toEqual({ kind: 'ready' })
  })
})

describe('loadSettings (launch)', () => {
  it('applies the saved camera, stream URL, sensitivity and mode', async () => {
    api.getSettings.mockResolvedValue({ ...SETTINGS, cameraEnabled: false, sensitivity: 'high', mode: 'dictation' })
    await c.loadSettings()
    expect(getApp()).toMatchObject({
      cameraOn: false,
      cameraSource: SETTINGS.cameraSource,
      streamUrl: STREAM,
      sensitivity: 'high',
      mode: 'dictation'
    })
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('a saved stream showed frames before: when it is off, it is retried rather than replaced', async () => {
    await c.loadSettings()
    c.cameraStatus("Can't reach the ESP32 stream")
    expect(getApp().cameraSource).toEqual(SETTINGS.cameraSource)
    expect(getApp().notice).toBeNull()
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('keeps the defaults when the settings cannot be read', async () => {
    api.getSettings.mockRejectedValue(new Error('no main process'))
    await c.loadSettings()
    expect(getApp()).toMatchObject({ cameraOn: true, cameraSource: { kind: 'builtin' }, sensitivity: 'medium', mode: 'command' })
    expect(getApp().view).toEqual({ kind: 'ready' })
  })
})

describe('mockServices', () => {
  it('emits nothing after a stop during a pending confirmation', async () => {
    const mock = mockServices()
    const events: AgentEvent['type'][] = []
    mock.onAgentEvent((e) => events.push(e.type))
    await mock.agentRun({ intent: 'x', sentence: 'x', frontmost: null })
    await settle(1400)
    expect(events.at(-1)).toBe('confirm')
    await mock.agentStop()
    await settle(5000)
    expect(events.at(-1)).toBe('stopped')
    expect(events).not.toContain('done')
  })
})

describe('shortcuts and toasts', () => {
  it('collapsed shortcut -> toast with compiled meta -> back to collapsed', async () => {
    const run = vi.spyOn(services, 'runShortcut')
    c.setView({ kind: 'collapsed' })
    c.gesture({ gesture: 'shape', shapeId: 'builtin-peace' })
    expect(run).toHaveBeenCalledWith('builtin-peace')
    await settle(400)
    expect(getApp().view).toEqual({
      kind: 'toast',
      title: 'Screenshot taken',
      subtitle: 'Saved to Desktop',
      ok: true,
      meta: 'compiled · 0.4 s',
      returnTo: 'collapsed'
    })
    await settle(TOAST_MS - 1)
    expect(getApp().view.kind).toBe('toast')
    await settle(1)
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('a shortcut from ready returns to ready', async () => {
    c.gesture({ gesture: 'shape', shapeId: 'g2' })
    await settle(400)
    expect(viewAs('toast')).toMatchObject({ title: 'Playing Motion Sickness', returnTo: 'ready' })
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('uncompiled shortcuts show no meta', async () => {
    vi.spyOn(services, 'runShortcut').mockResolvedValue({
      ok: true,
      title: 'Done',
      subtitle: '',
      compiled: false,
      durationMs: 3000
    })
    c.gesture({ gesture: 'shape', shapeId: 'g2' })
    await settle()
    expect(viewAs('toast').meta).toBeUndefined()
  })

  describe('shortcut runs on the card', () => {
    const generic = { kind: 'generic' as const, title: 'Send message', lines: [] }

    /** Manual agent events plus a shortcut whose result the test hands back. */
    function manualShortcut() {
      const { services: manual, emit } = manualAgent(services)
      let finish: (res: ShortcutRunResult) => void = () => {}
      manual.runShortcut = vi.fn(() => new Promise<ShortcutRunResult>((resolve) => (finish = resolve)))
      useServices(manual)
      return { manual, emit, finish: (res: ShortcutRunResult) => finish(res) }
    }

    it('a replay that needs a confirm shows Working and Confirm; the result is the toast, not a Done card', async () => {
      const { manual, emit, finish } = manualShortcut()
      c.setView({ kind: 'collapsed' })
      c.gesture({ gesture: 'shape', shapeId: 'g2' })
      emit({ type: 'started', runId: 's1', intent: 'Text Mom hi' })
      expect(getApp().view).toEqual({ kind: 'working', intent: 'Text Mom hi', steps: [] })
      emit({ type: 'confirm', runId: 's1', requestId: 'q1', tool: 'message_send', details: generic })
      g('thumbsUp')
      expect(manual.agentRespond).toHaveBeenCalledWith('q1', true)
      emit({ type: 'step', runId: 's1', step: { id: '1', label: 'Sending message', status: 'done' } })
      expect(viewAs('working').steps).toHaveLength(1)
      emit({ type: 'done', runId: 's1', result: { title: 'Message sent', subtitle: 'To Mom', evidence: [] }, complete: true })
      viewAs('working')
      finish({ ok: true, title: 'Message sent', subtitle: 'To Mom', compiled: true, durationMs: 1200 })
      await settle()
      expect(getApp().view).toEqual({
        kind: 'toast',
        title: 'Message sent',
        subtitle: 'To Mom',
        ok: true,
        meta: 'compiled · 1.2 s',
        returnTo: 'collapsed'
      })
    })

    it('the agent fallback after a failed replay step is adopted too', async () => {
      const { manual, emit, finish } = manualShortcut()
      c.gesture({ gesture: 'shape', shapeId: 'g2' })
      emit({ type: 'started', runId: 's1', intent: 'Play Motion Sickness' })
      emit({ type: 'step', runId: 's1', step: { id: '1', label: 'Playing', status: 'error' } })
      emit({ type: 'started', runId: 's2', intent: 'Play Motion Sickness' })
      emit({ type: 'step', runId: 's2', step: { id: 'p', label: 'Thinking', status: 'current' } })
      expect(viewAs('working').steps).toEqual([{ id: 'p', label: 'Thinking', status: 'current' }])
      emit({ type: 'confirm', runId: 's2', requestId: 'q2', tool: 'message_send', details: generic })
      viewAs('confirm')
      expect(manual.agentRespond).not.toHaveBeenCalled()
      g('fist')
      expect(manual.agentRespond).toHaveBeenCalledWith('q2', false)
      emit({ type: 'done', runId: 's2', result: { title: 'Nothing was done', subtitle: 'You cancelled it', evidence: [] }, complete: false })
      finish({ ok: false, title: 'Nothing was done', subtitle: 'You cancelled it', compiled: false, durationMs: 5000 })
      await settle()
      expect(viewAs('toast')).toMatchObject({ ok: false, title: 'Nothing was done', subtitle: 'You cancelled it', meta: undefined })
    })

    it('a fist stops it at once; the shortcut\'s own "Stopped" result is not toasted again', async () => {
      const { manual, emit, finish } = manualShortcut()
      c.gesture({ gesture: 'shape', shapeId: 'g2' })
      emit({ type: 'started', runId: 's1', intent: 'Play Motion Sickness' })
      g('fist')
      expect(manual.agentStop).toHaveBeenCalled()
      expect(viewAs('toast')).toMatchObject({ title: 'Stopped', subtitle: 'The agent was interrupted' })
      emit({ type: 'stopped', runId: 's1' })
      finish({ ok: false, title: 'Stopped', subtitle: 'The shortcut was stopped', compiled: false, durationMs: 300 })
      await settle()
      expect(viewAs('toast').subtitle).toBe('The agent was interrupted')
    })

    it('a command started while a silent shortcut runs replaces it: no toast over the Working card', async () => {
      const { emit, finish } = manualShortcut()
      c.gesture({ gesture: 'shape', shapeId: 'g2' })
      c.setView({ kind: 'agentReady', intent: 'Open Calculator', variant: 'default', sentence: 'Open Calculator' })
      g('thumbsUp')
      await settle()
      finish({ ok: false, title: 'Stopped', subtitle: 'The shortcut was stopped', compiled: true, durationMs: 300 })
      await settle()
      expect(viewAs('working').intent).toBe('Open Calculator')
      // Its runs are no longer adopted either.
      emit({ type: 'started', runId: 's9', intent: 'Play Motion Sickness' })
      expect(viewAs('working').intent).toBe('Open Calculator')
    })

    it('a shortcut\'s fallback that announces itself before the command\'s reply is not taken for the command', async () => {
      const { manual, emit, finish } = manualShortcut()
      let reply: (value: { ok: true; value: { runId: string } }) => void = () => {}
      vi.mocked(manual.agentRun).mockImplementation(() => new Promise((resolve) => (reply = resolve)))
      c.gesture({ gesture: 'shape', shapeId: 'g2' }) // a silent compiled replay
      c.setView({ kind: 'agentReady', intent: 'Text Mom on my way', variant: 'default', sentence: 'Text Mom on my way' })
      g('thumbsUp')
      await settle()
      // The replay failed first, so main started its agent fallback; the command then stops it.
      emit({ type: 'started', runId: 'f', intent: 'Play Motion Sickness' })
      emit({ type: 'stopped', runId: 'f' })
      emit({ type: 'started', runId: 'u', intent: 'Text Mom on my way' })
      emit({ type: 'step', runId: 'u', step: { id: 'p', label: 'Thinking', status: 'current' } })
      reply({ ok: true, value: { runId: 'u' } })
      await settle()
      expect(viewAs('working')).toMatchObject({ intent: 'Text Mom on my way', steps: [{ id: 'p', label: 'Thinking', status: 'current' }] })
      emit({ type: 'confirm', runId: 'u', requestId: 'q1', tool: 'message_send', details: generic })
      viewAs('confirm')
      expect(manual.agentRespond).not.toHaveBeenCalled()
      finish({ ok: false, title: 'Stopped', subtitle: 'The shortcut was stopped', compiled: false, durationMs: 5000 })
      await settle()
      g('thumbsUp')
      expect(manual.agentRespond).toHaveBeenCalledWith('q1', true)
      emit({ type: 'done', runId: 'u', result: { title: 'Message sent', subtitle: 'to Mom', evidence: [] }, complete: true })
      expect(viewAs('done')).toMatchObject({ ok: true, title: 'Message sent', intent: 'Text Mom on my way' })
    })

    it('a run nobody started is ignored, and its confirm declined', () => {
      const { manual, emit } = manualShortcut()
      emit({ type: 'started', runId: 'x', intent: 'Send money' })
      emit({ type: 'confirm', runId: 'x', requestId: 'qx', tool: 'mail_send', details: generic })
      expect(getApp().view).toEqual({ kind: 'ready' })
      expect(manual.agentRespond).toHaveBeenCalledWith('qx', false)
    })

    it('a shortcut that throws still toasts', async () => {
      vi.spyOn(services, 'runShortcut').mockRejectedValue(new Error('main crashed'))
      c.gesture({ gesture: 'shape', shapeId: 'g2' })
      await settle()
      expect(viewAs('toast')).toMatchObject({ ok: false, title: 'Shortcut failed', subtitle: 'main crashed' })
    })
  })

  it('shape gestures without an id are ignored', () => {
    const run = vi.spyOn(services, 'runShortcut')
    c.gesture({ gesture: 'shape' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a fist dismisses a toast early', async () => {
    c.setView({ kind: 'collapsed' })
    c.gesture({ gesture: 'shape', shapeId: 'builtin-peace' })
    await settle(400)
    g('fist')
    expect(getApp().view).toEqual({ kind: 'collapsed' })
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('closing a toast goes back where it came from', () => {
    c.setView({ kind: 'toast', title: 't', ok: true, returnTo: 'collapsed' })
    c.tap('close')
    expect(getApp().view).toEqual({ kind: 'collapsed' })
    c.setView({ kind: 'toast', title: 't', ok: true, returnTo: 'collapsed' })
    c.tap('secondary')
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('a toast shown in dictation mode returns to dictation', async () => {
    setApp({ mode: 'dictation' })
    c.setView({ kind: 'dictation', text: 'hi' })
    c.toast('Copied', undefined, true)
    expect(viewAs('toast').returnTo).toBe('ready')
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
  })
})

describe('LLM status notice (rate limits)', () => {
  const RATE_LIMITED = 'Rate limited, retrying...'
  type Pending<T> = { status: (s: string) => void; answer: (res: T) => void; signal?: AbortSignal }

  /** interpret / spellSuggest that wait for the test: each call's status listener, answer and signal are kept. */
  function heldLlm() {
    const interprets: Pending<Awaited<ReturnType<Services['interpret']>>>[] = []
    const spells: Pending<Awaited<ReturnType<Services['spellSuggest']>>>[] = []
    useServices({
      ...mockServices(),
      interpret: (_req, onStatus, signal) =>
        new Promise((answer) => interprets.push({ status: (s) => onStatus?.(s), answer, signal })),
      spellSuggest: (_req, onStatus, signal) =>
        new Promise((answer) => spells.push({ status: (s) => onStatus?.(s), answer, signal }))
    })
    return { interprets, spells }
  }

  it('shows while the interpretation retries, through Understanding..., and goes with the answer', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    expect(llm.interprets).toHaveLength(1)
    llm.interprets[0].status(RATE_LIMITED)
    expect(getApp().notice).toBe(RATE_LIMITED)
    g('thumbsUp')
    expect(viewAs('sentence').thinking).toBe(true)
    expect(getApp().notice).toBe(RATE_LIMITED)

    llm.interprets[0].answer({ ok: true, value: intentResult({ intent: 'Open Notes' }) })
    await settle()
    expect(viewAs('agentReady').intent).toBe('Open Notes')
    expect(getApp().notice).toBeNull()
  })

  it('gives way to the final error, shown as before', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    g('thumbsUp')
    llm.interprets[0].answer({ ok: false, error: 'Gemini is rate limited. Try again in a minute' })
    await settle()
    expect(getApp().notice).toBe('Gemini is rate limited. Try again in a minute')
    expect(viewAs('agentReady')).toMatchObject({ intent: 'Meeting tomorrow at 3 pm' })
    await settle(5000)
    expect(getApp().notice).toBeNull()
  })

  it('goes at once when the sentence is edited, and the old call cannot bring it back', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    c.editSentence('open notes')
    expect(getApp().notice).toBeNull()
    await settle()
    expect(llm.interprets).toHaveLength(2)

    llm.interprets[0].status(RATE_LIMITED)
    expect(getApp().notice).toBeNull()
    llm.interprets[0].answer({ ok: false, error: 'Gemini is rate limited. Try again in a minute' })
    await settle()
    expect(getApp().notice).toBeNull()

    // The new call's own status still shows.
    llm.interprets[1].status(RATE_LIMITED)
    expect(getApp().notice).toBe(RATE_LIMITED)
  })

  it('goes when the phrase is cancelled', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    g('fist')
    expect(viewAs('ready')).toBeTruthy()
    expect(getApp().notice).toBeNull()
    llm.interprets[0].status(RATE_LIMITED)
    expect(getApp().notice).toBeNull()
  })

  it('never covers another notice, and never clears it', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    setApp({ notice: 'Add GEMINI_API_KEY to .env' })
    llm.interprets[0].status(RATE_LIMITED)
    expect(getApp().notice).toBe('Add GEMINI_API_KEY to .env')
    llm.interprets[0].answer({ ok: true, value: intentResult({ intent: 'Open Notes' }) })
    await settle()
    expect(getApp().notice).toBe('Add GEMINI_API_KEY to .env')
  })

  it('a notice that comes up meanwhile is left alone when the call settles', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    c.notify('Still typing the last pick')
    llm.interprets[0].status(RATE_LIMITED)
    expect(getApp().notice).toBe('Still typing the last pick')
    llm.interprets[0].answer({ ok: true, value: intentResult({}) })
    await settle()
    expect(getApp().notice).toBe('Still typing the last pick')
  })

  it('shows while the spellings retry, and goes when the user moves on', async () => {
    setApp({ mode: 'spell' })
    const llm = heldLlm()
    sign(letter('K'), letter('R'))
    g('handsDown')
    await settle()
    llm.spells[0].status(RATE_LIMITED)
    expect(getApp().notice).toBe(RATE_LIMITED)
    expect(viewAs('didYouMean').pending).toBe(true)

    g('fist')
    expect(getApp().notice).toBeNull()
    llm.spells[0].status(RATE_LIMITED)
    expect(getApp().notice).toBeNull()
  })

  it('a spelling status goes with the spellings', async () => {
    setApp({ mode: 'spell' })
    const llm = heldLlm()
    sign(letter('K'), letter('R'))
    g('handsDown')
    await settle()
    llm.spells[0].status(RATE_LIMITED)
    llm.spells[0].answer({ ok: true, value: ['Krish'] })
    await settle()
    expect(viewAs('didYouMean').options).toEqual(['KR', 'Krish'])
    expect(getApp().notice).toBeNull()
  })

  it('says on the Sentence card itself when the retries run out, without waiting for proceed', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    llm.interprets[0].answer({ ok: false, error: 'Gemini is rate limited. Try again in a minute' })
    await settle()
    expect(viewAs('sentence').thinking).toBeFalsy()
    expect(getApp().notice).toBe('Gemini is rate limited. Try again in a minute')
    await settle(5000)
    expect(getApp().notice).toBeNull()

    // Proceeding later still says it, as before.
    g('thumbsUp')
    await settle()
    expect(getApp().notice).toBe('Gemini is rate limited. Try again in a minute')
    expect(viewAs('agentReady').intent).toBe('Meeting tomorrow at 3 pm')
  })

  it('a prefetch that fails without having shown a status stays quiet until proceed, as before', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    llm.interprets[0].answer({ ok: false, error: 'Gemini is busy right now. Try again in a moment' })
    await settle()
    expect(getApp().notice).toBeNull()
  })

  it("a new call's status takes the place of the last call's error", async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    g('thumbsUp')
    llm.interprets[0].answer({ ok: false, error: 'Gemini is rate limited. Try again in a minute' })
    await settle()
    expect(getApp().notice).toBe('Gemini is rate limited. Try again in a minute')

    g('swipeLeft') // Edit: back to the sentence, which is interpreted again
    await settle()
    expect(llm.interprets).toHaveLength(2)
    llm.interprets[1].status(RATE_LIMITED)
    expect(getApp().notice).toBe(RATE_LIMITED)
    llm.interprets[1].answer({ ok: true, value: intentResult({ intent: 'Open Notes' }) })
    await settle()
    expect(getApp().notice).toBeNull()
  })

  it('picking an ambiguous sign drops the old sentence\'s call and its status', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    c.ambiguousSign(['today', 'tonight'])
    fingers(1)
    expect(viewAs('building').sentence).toBe('Meeting tomorrow at 3 pm today')
    expect(getApp().notice).toBeNull()
    expect(llm.interprets[0].signal?.aborted).toBe(true)
    llm.interprets[0].status(RATE_LIMITED)
    expect(getApp().notice).toBeNull()
  })

  it('cancels a call once the card drops it: edited, cancelled or moved on from', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    expect(llm.interprets[0].signal?.aborted).toBe(false)
    c.editSentence('open notes')
    expect(llm.interprets[0].signal?.aborted).toBe(true)
    await settle()
    expect(llm.interprets[1].signal?.aborted).toBe(false)
    g('fist')
    expect(llm.interprets[1].signal?.aborted).toBe(true)

    setApp({ mode: 'spell' })
    sign(letter('K'), letter('R'))
    g('handsDown')
    await settle()
    expect(llm.spells[0].signal?.aborted).toBe(false)
    g('fist')
    expect(llm.spells[0].signal?.aborted).toBe(true)
  })

  it('keeps the call the card is waiting on, and leaves an answered one alone', async () => {
    const llm = heldLlm()
    signSentence(...MEETING)
    await settle()
    g('thumbsUp') // Understanding... waits on the same call
    expect(llm.interprets).toHaveLength(1)
    expect(llm.interprets[0].signal?.aborted).toBe(false)
    llm.interprets[0].answer({ ok: true, value: intentResult({ intent: 'Open Notes' }) })
    await settle()
    expect(viewAs('agentReady').intent).toBe('Open Notes')
    g('fist')
    expect(llm.interprets[0].signal?.aborted).toBe(false)
  })
})
