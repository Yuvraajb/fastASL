import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  CompletedTask,
  CustomGesture,
  IdentifySignRequest,
  IntentResult,
  Result,
  Settings,
  ShortcutRunResult,
  SignGuess,
  SignTemplate,
  TemplateStore
} from '@shared/types'
import {
  Controller,
  IDENTIFYING,
  NONE_OF_THESE,
  NOT_A_SIGN,
  QUICK_MENU,
  SETTINGS_ROOT,
  SHOW_ME,
  SIGN_GUESS_COOLDOWN_MS,
  SIGN_GUESS_ERROR_EVERY_MS,
  TOAST_MS,
  TOAST_THUMB_MS,
  CANCELLED_NOTE,
  GESTURE_SUGGESTIONS,
  isCallPhrase,
  GESTURE_TASK_LABEL,
  STOPPED_NOTE,
  UNDERSTANDING_STEP,
  type UnknownMovement,
  answerFor,
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
import { FRAME_FEATURE_DIM, HAND_FEATURE_DIM } from '../engine/recognition/features'
import { live } from './live'
import { MOCK_SCREENSHOT_PATH, MOCK_SCREENSHOT_THUMB } from './mockThumb'
import { mockServices, type Services } from './services'
import { getApp, setApp, useApp } from './store'
import {
  cardWidth,
  isChatCard,
  MAX_CHAT,
  statusFor,
  type Answer,
  type ChatMessage,
  type SettingsPage,
  type Token,
  type View
} from './types'

// Mirrors the controller's private timings.
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

type Conversation = Extract<View, { kind: 'conversation' }>

/** The transcript at a glance: "you:text", "agent:steps", "note:Stopped"... */
const chatShape = (): string[] => getApp().chat.map((m) => (m.kind === 'note' ? `note:${m.text}` : `${m.from}:${m.kind}`))

/** The conversation card in `phase`. */
function conversation(phase: Conversation['phase']): Conversation {
  const view = viewAs('conversation')
  expect(view.phase).toBe(phase)
  return view
}

/** Signs the phrase and lowers both hands: the conversation card, while the interpreter reads it. */
function sendPhrase(...tokens: Token[]): Conversation {
  sign(...tokens)
  g('handsDown')
  return conversation('understanding')
}

/** A phrase sent and answered in words by the mock agent (interpret 500 ms, then 700 ms): the reply card. */
async function toReply(...tokens: Token[]): Promise<Conversation> {
  sendPhrase(...tokens)
  await settle(1300)
  return conversation('reply')
}

/** The meeting phrase sent and interpreted (mock interpret: 500 ms): the agent is working on it. */
async function toWorking(): Promise<Conversation> {
  sendPhrase(...MEETING)
  await settle(500)
  return conversation('working')
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
    const spellings: View = { kind: 'didYouMean', options: [], purpose: 'spell' }
    const signs: View = { kind: 'didYouMean', options: [], purpose: 'sign' }
    expect(activeGestures(spellings).has('fingers')).toBe(true)
    expect(activeGestures(spellings).has('swipeLeft')).toBe(true)
    expect(activeGestures(signs).has('swipeLeft')).toBe(false)
  })

  it('the conversation card: only a fist while the interpreter or the agent works; the reply has Ready\'s gestures', () => {
    for (const phase of ['understanding', 'working'] as const) {
      expect(activeGestures({ kind: 'conversation', phase, said: 'Hi', steps: [] })).toEqual(new Set(['fist']))
    }
    const reply: View = { kind: 'conversation', phase: 'reply', said: 'Hi', steps: [], answer: { ok: true, text: 'Hello!' } }
    expect(activeGestures(reply)).toEqual(activeGestures({ kind: 'ready' }))
    expect(activeGestures(reply, 'spell')).toEqual(activeGestures({ kind: 'ready' }, 'spell'))
    expect(takesSigns(reply)).toBe(true)
    expect(takesSigns({ kind: 'conversation', phase: 'working', said: 'Hi', steps: [] })).toBe(false)
    // A thumbs up or fist already up while the agent worked doesn't act on the reply.
    expect(gestureScreen(reply)).not.toBe(gestureScreen({ kind: 'conversation', phase: 'working', said: 'Hi', steps: [] }))
  })

  it('numbers the options each view offers', () => {
    expect(optionsFor({ kind: 'ready' })).toEqual([])
    expect(optionsFor({ kind: 'quickMenu', options: QUICK_MENU })).toEqual(QUICK_MENU)
    expect(optionsFor({ kind: 'settings', settings: { page: 'root' } })).toEqual(SETTINGS_ROOT)
    expect(optionsFor({ kind: 'conversation', phase: 'reply', said: 'Hi', steps: [], answer: { ok: true, text: 'Hello!' } })).toEqual([])
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

  it('a fist hides the card only in Spell mode: elsewhere words start with one (YES, TIME)', () => {
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
    setApp({ mode: 'spell' })
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
    sendPhrase(...MEETING)
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

  it('new gesture offers Open 6 Claude Code terminals after the recent tasks, once', async () => {
    c.openSettings()
    fingers(2)
    await settle()
    expect(optionsFor(getApp().view)).toEqual(['Open Notes', 'Open 6 Claude Code terminals', 'Sign a new task'])
    fingers(2)
    expect(viewAs('settings').settings).toEqual({ page: 'newGestureHold', task: 'Open 6 Claude Code terminals', countdown: 3 })
    // Once it has run, it is a recent task: listed there, not twice.
    api.getRecentTasks.mockResolvedValue([{ intent: 'Open 6 Claude Code terminals', title: 'Opened 6 Claude Code terminals', at: 1, evidence: [] }, ...RECENT])
    c.startNewGesture()
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Open 6 Claude Code terminals', 'Open Notes'] })
  })

  it('new gesture lists recent tasks, then holds for the shape', async () => {
    c.openSettings()
    fingers(2)
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Open Notes', ...GESTURE_SUGGESTIONS] })
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
    await settle(TOAST_THUMB_MS)
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

  it("the agent's reply: swipe up opens Settings; a fist goes to Ready, with the conversation kept", async () => {
    sendPhrase(word('hello'))
    await settle(1300)
    conversation('reply')
    g('swipeUp')
    await settle(60_000)
    expect(page()).toEqual({ page: 'root' })
    expect(chatShape()).toEqual(['you:text', 'agent:text'])
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('1 Teach a sign: swipes page, fingers pick a sign (1: Show me a sign, 5: Spell a new word), and back leads to Settings', () => {
    c.openSettings()
    fingers(1)
    expect(page()).toMatchObject({ page: 'teachPick', offset: 0 })
    expect(optionsFor(getApp().view)).toEqual(['Show me a sign', 'YES', 'NO', 'HELLO', 'Spell a new word'])
    g('swipeRight')
    fingers(3)
    expect(page()).toEqual({ page: 'teachRecord', label: 'TOMORROW', kind: 'word', done: 0, total: 5 })
    g('fist')
    expect(page()).toMatchObject({ page: 'teachPick', offset: 3 })
    // A letter's page goes back by swipe: S, T, M and N are held still like a fist.
    for (let i = 0; i < 4; i++) g('swipeRight')
    fingers(3)
    expect(page()).toEqual({ page: 'teachRecord', label: 'A', kind: 'letter', done: 0, total: 5 })
    g('fist')
    expect(page()).toMatchObject({ page: 'teachRecord', label: 'A' })
    g('swipeLeft')
    expect(page()).toMatchObject({ page: 'teachPick', offset: 15 })
    fingers(1)
    expect(page()).toEqual({ page: 'teachShow', phase: 'waiting' })
    g('fist')
    expect(page()).toMatchObject({ page: 'teachPick', offset: 0 })
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
    expect(page()).toEqual({ page: 'newGesturePick', tasks: ['Open Notes', ...GESTURE_SUGGESTIONS] })
    fingers(1)
    expect(page()).toEqual({ page: 'newGestureHold', task: 'Open Notes', countdown: 3 })
    g('fist') // the shape being formed may read as a fist: only a swipe goes back
    expect(page()).toMatchObject({ page: 'newGestureHold' })
    g('swipeLeft')
    await settle()
    expect(page()).toEqual({ page: 'newGesturePick', tasks: ['Open Notes', ...GESTURE_SUGGESTIONS] })
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
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Open Notes', ...GESTURE_SUGGESTIONS] })
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
    /** Settings › New gesture › 3 (Sign a new task, after Open Notes and the suggestion). */
    async function signNewTask(): Promise<void> {
      c.openSettings()
      fingers(2)
      await settle()
      fingers(3)
    }

    it("goes to Ready with a hint; the phrase's intent becomes the task instead of an agent run", async () => {
      const agentRun = vi.spyOn(services, 'agentRun')
      await signNewTask()
      expect(getApp().view).toEqual({ kind: 'ready', hint: 'Sign the task for your gesture' })
      sendPhrase(...MEETING)
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
      sendPhrase(word('what'), word('time'))
      await settle(500)
      expect(hold().task).toBe('What time is my next meeting?')
    })

    it('takes the signed sentence without Claude, and says why', async () => {
      vi.spyOn(services, 'interpret').mockResolvedValue({ ok: false, error: 'no key', missingKey: 'ANTHROPIC_API_KEY' })
      await signNewTask()
      sendPhrase(...MEETING)
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
      sendPhrase(...MEETING)
      await settle()
      expect(hold().task).toBe('Take notes: Meeting tomorrow at 3 pm')
    })

    it('signs in Command mode, and ends with the phrase', async () => {
      setApp({ mode: 'dictation' })
      c.setView({ kind: 'dictation', text: '' })
      await signNewTask()
      expect(getApp().mode).toBe('command')
      expect(getApp().view).toEqual({ kind: 'ready', hint: 'Sign the task for your gesture' })
      sendPhrase(...MEETING)
      g('fist') // cancels while the interpreter reads it
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
  /** S is letter 18 of the list after the 16 starter words (index 33): the page at offset 33. */
  const S_PAGE = 33
  /** Spell a new word with some letter taught. */
  const spelling = (letters: string): SettingsPage => ({ page: 'teachSpell', letters, canSpell: true })

  it('lists starter words and letters by page, with the recorded count per label', () => {
    setApp({ templates: [tpl('YES', 1), tpl('YES', 2), tpl('V', 3)] })
    c.openSettings()
    fingers(1)
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 0, recorded: { YES: 2, V: 1 } })
    expect(optionsFor(getApp().view)).toEqual(['Show me a sign', 'YES', 'NO', 'HELLO', 'Spell a new word'])
    g('swipeLeft')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 0 })
    g('swipeRight')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 3 })
    expect(optionsFor(getApp().view)).toEqual(['Show me a sign', 'MEETING', 'TOMORROW', 'TIME', 'Spell a new word'])
    for (let i = 0; i < 10; i++) g('swipeRight')
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 33, recorded: { YES: 2, V: 1 } })
    expect(optionsFor(getApp().view)).toEqual(['Show me a sign', 'S', 'T', 'U', 'Spell a new word'])
    for (let i = 0; i < 20; i++) g('swipeRight')
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 39, recorded: { YES: 2, V: 1 } })
    expect(optionsFor(getApp().view)).toEqual(['Show me a sign', 'Y', 'Spell a new word'])
  })

  it('records words and letters 5 times each; the last option spells a new word', () => {
    const list = (offset: number): View => ({ kind: 'settings', settings: { page: 'teachPick', offset, recorded: {} } })
    c.setView(list(3))
    fingers(2)
    expect(viewAs('settings').settings).toEqual(RECORD_MEETING)
    c.setView(list(15))
    fingers(3)
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
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 3, recorded: { YES: 1, MEETING: 2 } })
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
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 3 })
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
  it('signStart says Listening in the header and leaves the card as it is', () => {
    c.signStart()
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().signing).toBe(true)
    c.signRejected()
    expect(getApp().signing).toBe(false)
    c.signStart()
    c.token(word('hello'))
    expect(getApp().signing).toBe(false)
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

  it("keeps Ready's gestures: a fist raised into view does nothing, a thumbs-up opens the quick menu", () => {
    c.signStart()
    expect(activeGestures(getApp().view)).toEqual(activeGestures({ kind: 'ready' }))
    const listening = getApp().view
    g('fist')
    expect(getApp().view).toEqual(listening)
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
      { kind: 'conversation', phase: 'reply', said: 'Hi', steps: [], answer: { ok: true, text: 'Hello!' } },
      { kind: 'dictation', text: '' },
      { kind: 'settings', settings: { page: 'teachSpell', letters: '', canSpell: true } }
    ]
    const no: View[] = [
      { kind: 'collapsed' },
      { kind: 'conversation', phase: 'understanding', said: 'Hi', steps: [] },
      { kind: 'conversation', phase: 'working', said: 'Hi', steps: [] },
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

  it('keeps adding signs for as long as the user signs: nothing stops after one sign', () => {
    const words = ['hello', 'my', 'name', 'is', 'sam', 'nice', 'to', 'meet', 'you'].map(word)
    sign(...words)
    expect(viewAs('building')).toMatchObject({ tokens: words, current: 'you', sentence: 'Hello my name is sam nice to meet you' })
  })

  it.each(['handsDown', 'thumbsUp', 'swipeRight'] as const)('%s in building sends the phrase: the conversation card, with no Sentence card', (gesture) => {
    sign(...MEETING)
    g(gesture)
    expect(getApp().view).toEqual({ kind: 'conversation', phase: 'understanding', said: 'Meeting tomorrow at 3 pm', steps: [] })
  })

  it('the proceed button and phraseEnd() also send it', () => {
    sign(word('hi'), word('there'))
    c.tap('proceed')
    expect(conversation('understanding').said).toBe('Hi there')

    c.tap('close')
    expect(getApp().view).toEqual({ kind: 'ready' })
    sign(word('hi'))
    c.phraseEnd()
    expect(conversation('understanding').said).toBe('Hi')
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

  it('signs are not taken while the interpreter or the agent works on the phrase', async () => {
    sendPhrase(word('hello'))
    const understanding = getApp().view
    c.token(word('again'))
    expect(getApp().view).toBe(understanding)
    await settle(500)
    const working = conversation('working')
    c.token(word('again'))
    expect(getApp().view).toBe(working)
  })

  it("the next sign after the agent's reply starts a new phrase on the Building card", async () => {
    await toReply(word('hello'))
    c.token(word('what'))
    expect(viewAs('recognizing').token).toBe('what')
    c.token(word('time'))
    expect(viewAs('building')).toMatchObject({ tokens: [word('what'), word('time')], sentence: 'What time', current: 'time' })
  })

  it('a movement on the reply keeps it until a sign arrives; a sign moves on', async () => {
    const reply = await toReply(word('hello'))
    c.signStart()
    expect(getApp().view).toBe(reply)
    expect(getApp().signing).toBe(true)
    c.signRejected()
    expect(getApp().view).toBe(reply)
    c.signStart()
    c.token(word('thank you'))
    expect(viewAs('recognizing').token).toBe('thank you')
    c.token(word('friend'))
    expect(viewAs('building').sentence).toBe('Thank you friend')
  })

  it('ignores tokens in views that are not collecting a phrase', () => {
    const settings: View = { kind: 'settings', settings: { page: 'root' } }
    c.setView(settings)
    c.token(word('hi'))
    expect(getApp().view).toBe(settings)
  })
})

describe('sending a phrase: the interpreter, then straight to the agent', () => {
  it('hands down shows the conversation card at once; the interpreted message goes to the agent with nothing to confirm', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    const run = vi.spyOn(services, 'agentRun')
    sign(...MEETING)
    g('handsDown')
    expect(getApp().view).toEqual({ kind: 'conversation', phase: 'understanding', said: 'Meeting tomorrow at 3 pm', steps: [] })
    expect(statusFor(getApp().view, 'command')).toEqual({ label: 'Working...', tone: 'idle' })
    await settle()
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
    expect(run).not.toHaveBeenCalled()

    await settle(500)
    expect(run).toHaveBeenCalledWith({
      intent: 'Schedule a meeting tomorrow at 3pm with the team',
      sentence: 'Meeting tomorrow at 3pm.',
      frontmost: { name: 'Mail', windowTitle: 'New Message' }
    })
    expect(getApp().view).toEqual({
      kind: 'conversation',
      phase: 'working',
      said: 'Meeting tomorrow at 3pm.',
      steps: [{ id: 's0', label: 'Opening Calendar', status: 'current' }]
    })
  })

  it('a greeting goes to the agent as the sentence itself (the interpreter found no task in it)', async () => {
    const run = vi.spyOn(services, 'agentRun')
    sendPhrase(word('hello'))
    await settle(500)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ intent: 'Hello.', sentence: 'Hello.' }))
    expect(conversation('working').said).toBe('Hello.')
  })

  it.each([
    ['a missing key', { ok: false, error: 'no key', missingKey: 'GEMINI_API_KEY' }, 'Add GEMINI_API_KEY to .env'],
    ['a rate limit', { ok: false, error: 'Gemini is rate limited. Try again in 30 s' }, 'Gemini is rate limited. Try again in 30 s'],
    ['a timeout', { ok: false, error: 'Gemini took too long to answer' }, 'Gemini took too long to answer']
  ] as const)('an interpreter failure (%s) still sends what was signed, and says why', async (_case, failure, notice) => {
    vi.spyOn(services, 'interpret').mockResolvedValue(failure as Result<IntentResult>)
    const run = vi.spyOn(services, 'agentRun')
    sendPhrase(...MEETING)
    await settle()
    expect(getApp().notice).toBe(notice)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ intent: 'Meeting tomorrow at 3 pm', sentence: 'Meeting tomorrow at 3 pm' }))
    expect(conversation('working').said).toBe('Meeting tomorrow at 3 pm')
    await settle(5000)
    expect(getApp().notice).toBeNull()
  })

  it('a rejected interpret call (main crashed) still sends', async () => {
    vi.spyOn(services, 'interpret').mockRejectedValue(new Error('IPC failed'))
    const run = vi.spyOn(services, 'agentRun')
    sendPhrase(word('hello'))
    await settle()
    expect(getApp().notice).toBe('IPC failed')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ intent: 'Hello', sentence: 'Hello' }))
  })

  it("a low-confidence reading is not asked about (no Did you mean): what was signed goes instead of its guess", async () => {
    const run = vi.spyOn(services, 'agentRun')
    sendPhrase(word('what'), word('time'), word('next'), word('meeting'))
    await settle(500)
    expect(getApp().view.kind).not.toBe('didYouMean')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ intent: 'What time next meeting', sentence: 'What time next meeting' }))
    expect(conversation('working').said).toBe('What time next meeting')

    run.mockClear()
    vi.spyOn(services, 'interpret').mockResolvedValue({
      ok: true,
      value: intentResult({ sentence: 'Open my notes.', intent: 'Open Notes', alternatives: ['Take notes'], confidence: 0.4 })
    })
    g('fist')
    await settle(TOAST_MS)
    sendPhrase(word('notes'))
    await settle()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ intent: 'Notes', sentence: 'Notes' }))
  })

  it('a quick-menu pick reaches the interpreter and shows on the card; without the interpreter it prefixes the message', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    const run = vi.spyOn(services, 'agentRun')
    g('thumbsUp')
    fingers(1)
    expect(getApp().view).toEqual({ kind: 'ready', hint: 'Create event: sign the details' })
    sendPhrase(...MEETING)
    expect(conversation('understanding').prefix).toBe('Create event')
    await settle(500)
    expect(interpret.mock.calls[0][0].intentPrefix).toBe('Create event')
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ intent: 'Schedule a meeting tomorrow at 3pm with the team' }))
    expect(conversation('working').prefix).toBe('Create event')

    g('fist')
    await settle(TOAST_MS)
    interpret.mockResolvedValue({ ok: false, error: 'offline' })
    g('thumbsUp')
    fingers(1)
    sendPhrase(...MEETING)
    await settle()
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent: 'Create event: Meeting tomorrow at 3 pm', sentence: 'Meeting tomorrow at 3 pm' })
    )
  })

  it('cancelling the quick menu clears the prefix', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    g('thumbsUp')
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
    sendPhrase(word('hello'))
    await settle()
    expect(interpret.mock.calls[0][0].intentPrefix).toBeUndefined()
  })

  it('a fist or the X while the interpreter reads drops the phrase: its call is cancelled and the agent never starts', async () => {
    const run = vi.spyOn(services, 'agentRun')
    const signals: AbortSignal[] = []
    vi.spyOn(services, 'interpret').mockImplementation(async (_req, _onStatus, signal) => {
      if (signal) signals.push(signal)
      await new Promise((r) => setTimeout(r, 500))
      return { ok: true, value: intentResult({ intent: 'Do it' }) }
    })
    sendPhrase(...MEETING)
    await settle()
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(signals[0].aborted).toBe(true)
    await settle(500)
    expect(run).not.toHaveBeenCalled()
    expect(getApp().view).toEqual({ kind: 'ready' })

    sendPhrase(word('hi'))
    await settle()
    c.tap('close')
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(signals[1].aborted).toBe(true)
    await settle(500)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the conversation with the agent', () => {
  it('steps stream onto the card; a write waits on the Confirm card; the result shows under what was signed', async () => {
    const respond = vi.spyOn(services, 'agentRespond')
    await toWorking()
    expect(conversation('working').steps).toEqual([{ id: 's0', label: 'Opening Calendar', status: 'current' }])
    await settle(700)
    expect(conversation('working').steps.map((s) => s.status)).toEqual(['done', 'current'])
    await settle(700)
    const confirm = viewAs('confirm')
    expect(confirm.details).toMatchObject({ kind: 'event', title: 'Team Sync' })
    // Nothing is written until a thumbs up.
    await settle(30_000)
    expect(getApp().view).toBe(confirm)
    expect(respond).not.toHaveBeenCalled()

    g('thumbsUp')
    expect(respond).toHaveBeenCalledWith(confirm.requestId, true)
    expect(conversation('working')).toMatchObject({ said: 'Meeting tomorrow at 3pm.' })
    await settle()
    expect(conversation('working').steps.map((s) => s.status)).toEqual(['done', 'done', 'current'])
    await settle(1400)
    expect(conversation('reply')).toMatchObject({
      said: 'Meeting tomorrow at 3pm.',
      answer: {
        ok: true,
        title: 'Meeting created',
        subtitle: 'Tomorrow at 10:00 AM with 4 guests.',
        text: 'Team Sync is on your calendar for tomorrow at 10.',
        view: { kind: 'openApp', app: 'Calendar' }
      }
    })
    expect(statusFor(getApp().view, 'command')).toEqual({ label: 'Done', tone: 'active' })
  })

  it("a greeting: no tool runs, and the agent's own reply is shown (not \"Nothing was done\")", async () => {
    sendPhrase(word('hello'))
    await settle(500)
    expect(conversation('working').steps).toEqual([{ id: 'plan', label: 'Thinking', status: 'current' }])
    await settle(700)
    expect(conversation('reply')).toMatchObject({ said: 'Hello.', answer: { ok: true, text: 'Hello! What can I do for you?' } })
    expect(conversation('reply').answer?.title).toBeUndefined()
    expect(statusFor(getApp().view, 'command')).toEqual({ label: 'Reply', tone: 'active' })
  })

  it('a real conversation: each message is a new phrase sent to the same agent', async () => {
    const run = vi.spyOn(services, 'agentRun')
    await toReply(word('hello'))
    sign(word('what'), word('time'))
    g('handsDown')
    expect(conversation('understanding').said).toBe('What time')
    await settle(500)
    await settle(700)
    expect(conversation('reply').answer).toEqual({ ok: true, text: "It's 10:00 AM on Friday, October 25." })
    expect(run.mock.calls.map(([req]) => req.sentence)).toEqual(['Hello.', 'What time'])
  })

  it('confirm --fist--> denied: the agent cancels, and the card says nothing was done', async () => {
    const respond = vi.spyOn(services, 'agentRespond')
    await toWorking()
    await settle(1400)
    const confirm = viewAs('confirm')
    g('fist')
    expect(conversation('working').said).toBe('Meeting tomorrow at 3pm.')
    await settle()
    expect(respond).toHaveBeenCalledWith(confirm.requestId, false)
    expect(conversation('reply').answer).toEqual({ ok: false, title: 'Nothing was done', subtitle: 'You cancelled it' })
    expect(statusFor(getApp().view, 'command')).toEqual({ label: 'Done', tone: 'idle' })
  })

  it('confirm buttons: primary approves, close denies', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    const details = { kind: 'generic' as const, title: 'Delete file', lines: [] }
    void c.runAgent('Tidy up', 'Tidy up.')
    await settle()
    emit({ type: 'confirm', runId: 'r1', requestId: 'q1', tool: 'rm', details })
    c.tap('primary')
    expect(manual.agentRespond).toHaveBeenLastCalledWith('q1', true)
    emit({ type: 'confirm', runId: 'r1', requestId: 'q2', tool: 'rm', details })
    c.tap('close')
    expect(manual.agentRespond).toHaveBeenLastCalledWith('q2', false)
    expect(conversation('working').said).toBe('Tidy up.')
  })

  it('confirm returns to the live step list', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    void c.runAgent('Tidy up', 'Tidy up.')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Look', status: 'current' } })
    emit({ type: 'confirm', runId: 'r1', requestId: 'q1', tool: 'rm', details: { kind: 'generic', title: 't', lines: [] } })
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Look', status: 'done' } })
    g('thumbsUp')
    expect(conversation('working').steps).toEqual([{ id: 'a', label: 'Look', status: 'done' }])
  })

  it('a fist while the agent works stops it: the transcript says Stopped, and the card is a fresh Ready at once', async () => {
    const stop = vi.spyOn(services, 'agentStop')
    await toWorking()
    await settle(700)
    g('fist')
    await settle()
    expect(stop).toHaveBeenCalled()
    // No toast: the chat card stays, with "Stopped" in place of the steps.
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(chatShape()).toEqual(['you:text', `note:${STOPPED_NOTE}`])
    await settle(10_000)
    expect(getApp().view).toEqual({ kind: 'ready' })
    // The stopped phrase is gone: a new sign starts a new phrase.
    c.token(word('hi'))
    expect(viewAs('recognizing').token).toBe('hi')
  })

  it('the close button stops a working agent', async () => {
    const stop = vi.spyOn(services, 'agentStop')
    void c.runAgent('x', 'x')
    await settle()
    c.tap('close')
    await settle()
    expect(stop).toHaveBeenCalled()
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().chat.at(-1)).toMatchObject({ kind: 'note', text: STOPPED_NOTE })
  })

  it('stopping after a quick-menu command forgets its prefix', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    g('thumbsUp')
    fingers(1)
    sendPhrase(...MEETING)
    await settle(500)
    conversation('working')
    g('fist')
    await settle(TOAST_MS)
    sendPhrase(word('hi'))
    await settle()
    expect(interpret.mock.calls.map((call) => call[0].intentPrefix)).toEqual(['Create event', undefined])
  })

  it('ignores agent events that arrive after a stop', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    void c.runAgent('Play music', 'Play music.')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Opening Spotify', status: 'current' } })
    expect(conversation('working').steps).toHaveLength(1)
    g('fist')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Opening Spotify', status: 'done' } })
    emit({ type: 'error', runId: 'r1', message: 'Interrupted' })
    emit({ type: 'confirm', runId: 'r1', requestId: 'late', tool: 'x', details: { kind: 'generic', title: 't', lines: [] } })
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(chatShape()).toEqual(['you:text', `note:${STOPPED_NOTE}`])
    // A late confirmation request is denied so the agent never waits forever.
    expect(manual.agentRespond).toHaveBeenCalledWith('late', false)
  })

  it('a stopped run that had already sent something says so under "Stopped"', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    void c.runAgent('Text Mom on my way', 'Text Mom on my way.')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'm', label: 'Messaging Mom', status: 'current' } })
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
    // The send was already running: main reports it once it lands.
    const sent = [{ tool: 'message_send', args: {}, ok: true }]
    emit({ type: 'done', runId: 'r1', result: { title: 'Message sent', subtitle: 'You stopped the rest', evidence: sent }, complete: false })
    expect(chatShape()).toEqual(['you:text', `note:${STOPPED_NOTE}`, 'agent:result'])
    expect(getApp().chat.at(-1)).toMatchObject({ answer: { ok: false, title: 'Message sent', subtitle: 'You stopped the rest' } })
    expect(getApp().notice).toBeNull()
    expect(getApp().view).toEqual({ kind: 'ready' })

    // With the chat out of sight (collapsed), a notice says so too.
    void c.runAgent('Email Sam hi', 'Email Sam hi.')
    await settle()
    g('fist')
    c.collapse()
    emit({ type: 'done', runId: 'r1', result: { title: 'Email sent', subtitle: 'You stopped the rest', evidence: sent }, complete: false })
    expect(getApp().notice).toBe('Email sent before you stopped')
    expect(getApp().chat.at(-1)).toMatchObject({ kind: 'result', answer: { title: 'Email sent' } })
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('a stop before the agent starts never launches it', async () => {
    const run = vi.spyOn(services, 'agentRun')
    void c.runAgent('x', 'x')
    g('fist') // same frame, before frontmostApp() resolved
    await settle()
    expect(run).not.toHaveBeenCalled()
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(chatShape()).toEqual(['you:text', `note:${STOPPED_NOTE}`])
  })

  it('an agent that stops on its own says so in the transcript', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    void c.runAgent('x', 'x')
    await settle()
    emit({ type: 'stopped', runId: 'r1' })
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(chatShape()).toEqual(['you:text', `note:${STOPPED_NOTE}`])
  })

  it('an agent that cannot start says why on the card, which stays ready for the next message', async () => {
    vi.spyOn(services, 'agentRun').mockResolvedValue({ ok: false, error: 'nope', missingKey: 'FACTORY_API_KEY' })
    sendPhrase(word('hello'))
    await settle(500)
    expect(conversation('reply')).toMatchObject({
      said: 'Hello.',
      answer: { ok: false, title: "Couldn't start the agent", subtitle: 'Add FACTORY_API_KEY to .env' }
    })
    expect(statusFor(getApp().view, 'command')).toEqual({ label: 'Done', tone: 'idle' })
    // It takes the next message from there: a sign starts it.
    c.token(word('hello'))
    expect(viewAs('recognizing').token).toBe('hello')
  })

  it('a rejected start does not leave the card stuck on working', async () => {
    vi.spyOn(services, 'agentRun').mockRejectedValue(new Error('main crashed'))
    void c.runAgent('x', 'x')
    await settle()
    expect(conversation('reply').answer).toMatchObject({ ok: false, subtitle: 'main crashed' })
  })

  it('an error event ends the run', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    void c.runAgent('Play music', 'Play music.')
    await settle()
    emit({ type: 'error', runId: 'r1', message: 'Spotify is not running' })
    expect(conversation('reply')).toMatchObject({
      said: 'Play music.',
      answer: { ok: false, title: "Couldn't finish", subtitle: 'Spotify is not running' }
    })
    emit({ type: 'error', runId: 'r1', message: 'x', missingKey: 'SPOTIFY_CLIENT_ID' })
    expect(conversation('reply').answer?.subtitle).toBe('Spotify is not running')
  })

  it('an unfinished task is not ok, even with successful evidence; a complete one is, despite a failed retry', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    void c.runAgent('Text Mom hi', 'Text Mom hi.')
    await settle()
    const sent = [{ tool: 'message_send', args: {}, ok: true }]
    emit({ type: 'done', runId: 'r1', result: { title: 'Message sent', subtitle: 'Droid process exited', evidence: sent }, complete: false })
    expect(conversation('reply').answer).toEqual({ ok: false, title: 'Message sent', subtitle: 'Droid process exited' })
    // Not a completed task: New gesture doesn't suggest it.
    c.startNewGesture()
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Open Notes', ...GESTURE_SUGGESTIONS] })

    void c.runAgent('Play jazz', 'Play jazz.')
    await settle()
    const retried = [{ tool: 'spotify_play', args: {}, ok: false }, { tool: 'spotify_play', args: {}, ok: true }]
    emit({ type: 'done', runId: 'r1', result: { title: 'Playing jazz', subtitle: '', evidence: retried }, complete: true })
    expect(conversation('reply').answer?.ok).toBe(true)
    c.startNewGesture()
    await settle()
    expect(viewAs('settings').settings).toEqual({ page: 'newGesturePick', tasks: ['Play jazz', 'Open Notes', ...GESTURE_SUGGESTIONS] })
  })

  it("holds events until agentRun replies with the run id, then shows only that run's", async () => {
    const { services: manual, emit } = manualAgent(services)
    let reply: (value: { ok: true; value: { runId: string } }) => void = () => {}
    vi.mocked(manual.agentRun).mockImplementation(() => new Promise((resolve) => (reply = resolve)))
    useServices(manual)
    void c.runAgent('x', 'x')
    await settle()
    // The previous run's stop and this run's start arrive before the reply: nothing shows yet.
    emit({ type: 'stopped', runId: 'old' })
    emit({ type: 'started', runId: 'r2', intent: 'x' })
    emit({ type: 'step', runId: 'r2', step: { id: 'a', label: 'Thinking', status: 'current' } })
    emit({ type: 'step', runId: 'old', step: { id: 'b', label: 'Old step', status: 'current' } })
    emit({ type: 'confirm', runId: 'old', requestId: 'stale', tool: 'x', details: { kind: 'generic', title: 't', lines: [] } })
    expect(conversation('working').steps).toEqual([])
    reply({ ok: true, value: { runId: 'r2' } })
    await settle()
    expect(conversation('working').steps).toEqual([{ id: 'a', label: 'Thinking', status: 'current' }])
    expect(manual.agentRespond).toHaveBeenCalledWith('stale', false)
    emit({ type: 'done', runId: 'r2', result: { title: 'Opened', subtitle: '', evidence: [{ tool: 'open_app', args: {}, ok: true }] }, complete: true })
    expect(conversation('reply').answer?.title).toBe('Opened')
  })

  it('a failed start drops the events it held, declining their confirms', async () => {
    const { services: manual, emit } = manualAgent(services)
    let reply: (value: { ok: false; error: string }) => void = () => {}
    vi.mocked(manual.agentRun).mockImplementation(() => new Promise((resolve) => (reply = resolve)))
    useServices(manual)
    void c.runAgent('x', 'x')
    await settle()
    emit({ type: 'started', runId: 'old', intent: 'y' })
    emit({ type: 'confirm', runId: 'old', requestId: 'stale', tool: 'x', details: { kind: 'generic', title: 't', lines: [] } })
    reply({ ok: false, error: 'nope' })
    await settle()
    expect(conversation('reply').answer).toMatchObject({ ok: false, title: "Couldn't start the agent", subtitle: 'nope' })
    expect(manual.agentRespond).toHaveBeenCalledWith('stale', false)
  })

  it('still receives agent events after dispose() (React StrictMode remounts App)', async () => {
    c.dispose()
    void c.runAgent('Schedule a meeting', 'Meeting.')
    await settle()
    expect(conversation('working').steps).toHaveLength(1)
  })

  describe('the reply card', () => {
    const reply = (answer: Answer): View => ({ kind: 'conversation', phase: 'reply', said: 'Hi.', steps: [], answer })

    it('stays for as long as nothing happens: no idle timeout, and the conversation is never cleared', async () => {
      // The mock agent answers 1.2 s after hands down (interpret 0.5 s, then the agent 0.7 s).
      sendPhrase(word('hello'))
      await settle(1200)
      const shown = conversation('reply')
      await settle(5 * 60_000)
      expect(getApp().view).toBe(shown)
      // A movement that was no sign leaves it as it is.
      c.signStart()
      c.signRejected()
      expect(getApp().view).toBe(shown)
      expect(chatShape()).toEqual(['you:text', 'agent:text'])
      // The next message is appended under the exchange.
      sendPhrase(word('hello'))
      await settle(1200)
      expect(chatShape()).toEqual(['you:text', 'agent:text', 'you:text', 'agent:text'])
      await settle(5 * 60_000)
      expect(chatShape()).toEqual(['you:text', 'agent:text', 'you:text', 'agent:text'])
    })

    it("has Ready's gestures: a thumbs up opens the quick menu, a fist does nothing, swipes switch modes, swipe up opens Settings", () => {
      const shown = reply({ ok: true, text: 'Hello!' })
      c.setView(shown)
      g('thumbsUp')
      expect(viewAs('quickMenu').options).toEqual(QUICK_MENU)
      c.setView(shown)
      g('fist')
      expect(getApp().view).toBe(shown)
      c.setView(shown)
      g('swipeRight')
      expect(getApp().mode).toBe('dictation')
      expect(getApp().view).toEqual({ kind: 'dictation', text: '' })
      g('fist')
      c.setView(shown)
      g('swipeUp')
      expect(viewAs('settings').settings).toEqual({ page: 'root' })
    })

    it('a thumbs up (or a click) opens what the agent made, and the card stays; the X goes back to Ready', () => {
      const open = vi.spyOn(services, 'openTarget')
      const shown = reply({ ok: true, title: 'Meeting created', subtitle: '', view: { kind: 'openApp', app: 'Calendar' } })
      c.setView(shown)
      g('thumbsUp')
      expect(open).toHaveBeenCalledWith({ kind: 'openApp', app: 'Calendar' })
      expect(getApp().view).toBe(shown)
      c.tap('primary')
      expect(open).toHaveBeenCalledTimes(2)
      c.tap('close')
      expect(getApp().view).toEqual({ kind: 'ready' })
    })

    it('an ambiguous sign on the reply asks, and the pick starts the next phrase', () => {
      c.setView(reply({ ok: true, text: 'Hello!' }))
      c.ambiguousSign(['where', 'what'])
      expect(getApp().view).toEqual({ kind: 'didYouMean', options: ['where', 'what'], purpose: 'sign' })
      fingers(2)
      expect(viewAs('building')).toMatchObject({ tokens: [word('what')], sentence: 'What' })
    })
  })

  describe('a screenshot the agent took', () => {
    const SHOT = '/Users/me/Desktop/fastASL Screenshot 2026-10-24 at 15.45.12.png'
    const shot = { tool: 'take_screenshot', args: {}, ok: true }

    async function screenshotRun(thumb: Services['imageThumb']) {
      const { services: base, emit } = manualAgent(services)
      const imageThumb = vi.fn(thumb)
      const manual: Services = { ...base, imageThumb, openTarget: vi.fn(async () => {}) }
      useServices(manual)
      void c.runAgent('Take a screenshot', 'Take a screenshot.')
      await settle()
      emit({
        type: 'done',
        runId: 'r1',
        result: {
          title: 'Screenshot taken',
          subtitle: 'Desktop · fastASL Screenshot 2026-10-24 at 15.45.12.png',
          evidence: [shot],
          view: { kind: 'openFile', path: SHOT },
          reply: 'Saved it to your Desktop.'
        },
        complete: true
      })
      return { imageThumb, manual }
    }

    it("shows its thumbnail (from main) with the file name; a thumbs up opens it in Preview", async () => {
      const { imageThumb, manual } = await screenshotRun(async () => ({ ok: true, value: 'data:image/png;base64,AAA' }))
      expect(imageThumb).toHaveBeenCalledWith(SHOT)
      await settle()
      expect(conversation('reply').answer).toEqual({
        ok: true,
        title: 'Screenshot taken',
        subtitle: 'Desktop · fastASL Screenshot 2026-10-24 at 15.45.12.png',
        text: 'Saved it to your Desktop.',
        view: { kind: 'openFile', path: SHOT },
        thumb: 'data:image/png;base64,AAA'
      })
      g('thumbsUp')
      expect(manual.openTarget).toHaveBeenCalledWith({ kind: 'openFile', path: SHOT })
      conversation('reply')
    })

    it('a thumbnail main refuses, or one that never comes, is left out', async () => {
      await screenshotRun(async () => ({ ok: false, error: 'Not a screenshot fastASL took' }))
      await settle()
      expect(conversation('reply').answer).toMatchObject({ title: 'Screenshot taken', view: { kind: 'openFile', path: SHOT } })
      expect(conversation('reply').answer?.thumb).toBeUndefined()

      await screenshotRun(() => new Promise(() => {}))
      await settle(1499)
      conversation('working')
      await settle(1)
      expect(conversation('reply').answer?.thumb).toBeUndefined()
    })

    it('a stop while the thumbnail loads wins', async () => {
      await screenshotRun(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: 'data:x' }), 300)))
      g('fist')
      await settle(300)
      expect(getApp().view).toEqual({ kind: 'ready' })
      expect(chatShape()).toEqual(['you:text', `note:${STOPPED_NOTE}`])
    })

    it('files that are not images get no thumbnail call', async () => {
      const { services: manual, emit } = manualAgent(services)
      const imageThumb = vi.fn(async () => ({ ok: true as const, value: 'data:x' }))
      useServices({ ...manual, imageThumb })
      void c.runAgent('Open the report', 'Open the report.')
      await settle()
      const view = { kind: 'openFile' as const, path: '/Users/me/report.pdf' }
      emit({ type: 'done', runId: 'r1', result: { title: 'Opened report.pdf', subtitle: '', evidence: [shot], view }, complete: true })
      expect(conversation('reply').answer).toMatchObject({ view })
      expect(imageThumb).not.toHaveBeenCalled()
    })
  })

  describe('answerFor', () => {
    it("is the model's reply when no tool ran", () => {
      expect(answerFor({ title: 'Nothing was done', subtitle: "The agent didn't run any action", evidence: [], reply: 'Hi there!' }, false)).toEqual({
        ok: true,
        text: 'Hi there!'
      })
    })

    it('keeps the evidence-based title and subtitle when tools ran, with the reply under them', () => {
      const evidence = [{ tool: 'web_search', args: {}, ok: true }]
      const view = { kind: 'openUrl' as const, url: 'https://google.com' }
      expect(answerFor({ title: 'Searched the web', subtitle: 'asl', evidence, view, reply: 'Opened a search.' }, true)).toEqual({
        ok: true,
        title: 'Searched the web',
        subtitle: 'asl',
        text: 'Opened a search.',
        view
      })
    })

    it("is the model's reply when only lookups ran, not the lookup's headline", () => {
      const evidence = [{ tool: 'contacts_find', args: { query: 'Mom' }, ok: true }]
      expect(
        answerFor({ title: 'Found 18 contacts', subtitle: 'Mom Machli', evidence, reply: "I couldn't find a contact named exactly Mom." }, true)
      ).toEqual({ ok: true, text: "I couldn't find a contact named exactly Mom." })
    })

    it('says nothing was done (and why) when no tool ran and the model said nothing usable', () => {
      expect(answerFor({ title: 'Nothing was done', subtitle: 'You cancelled it', evidence: [] }, false)).toEqual({
        ok: false,
        title: 'Nothing was done',
        subtitle: 'You cancelled it'
      })
    })
  })

  describe('a failed start uses up the phrase', () => {
    const failedStart = async (): Promise<void> => {
      vi.spyOn(services, 'agentRun').mockResolvedValue({ ok: false, error: 'The agent is not available yet' })
      g('thumbsUp')
      fingers(1) // Create event: sign the details
      sendPhrase(word('meeting'), word('tomorrow'))
      await settle(500)
      expect(conversation('reply').answer?.title).toBe("Couldn't start the agent")
      g('swipeUp')
      g('fist')
      expect(getApp().view).toEqual({ kind: 'ready' })
    }

    it('failed start › settings › back › a sign begins a new phrase', async () => {
      const interpret = vi.spyOn(services, 'interpret')
      await failedStart()
      sendPhrase(word('hello'))
      await settle()
      expect(interpret.mock.calls.map(([req]) => [req.sentence, req.intentPrefix])).toEqual([
        ['Meeting tomorrow', 'Create event'],
        ['Hello', undefined]
      ])
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

describe('the caption camera (captioning)', () => {
  const captionsReady = { kind: 'ready', hint: expect.stringMatching(/^Captions on/) }

  it('a signed phrase is captions: sent in the transcript, no interpreter or agent, and Ready for the next at once', async () => {
    const interpret = vi.spyOn(services, 'interpret')
    const run = vi.spyOn(services, 'agentRun')
    c.setCaptioning(true)
    expect(getApp().view).toEqual(captionsReady)
    sign(word('tomorrow'), word('meeting'))
    g('handsDown')
    expect(getApp().view).toEqual(captionsReady)
    expect(getApp().chat.at(-1)).toMatchObject({ from: 'you', kind: 'text', text: 'Tomorrow meeting' })
    expect(getApp().composing.tokens).toEqual([])
    sign(word('what'), word('time'))
    g('handsDown')
    expect(getApp().chat.at(-1)).toMatchObject({ from: 'you', kind: 'text', text: 'What time' })
    await settle(60_000)
    expect(chatShape()).toEqual(['you:text', 'you:text'])
    expect(interpret).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('a phrase becomes English when the captions model answers; one sign, or no answer, keeps the signs', async () => {
    const captionText = vi
      .spyOn(services, 'captionText')
      .mockResolvedValueOnce({ ok: true, value: 'What time is the meeting tomorrow?' })
      .mockResolvedValueOnce({ ok: false, error: 'fetch failed' })
    c.setCaptioning(true)
    sign(word('tomorrow'), word('time'), word('what'), word('meeting'))
    g('handsDown')
    expect(getApp().chat.at(-1)).toMatchObject({ kind: 'text', text: 'Tomorrow time what meeting' })
    await settle()
    expect(captionText).toHaveBeenCalledWith(['tomorrow', 'time', 'what', 'meeting'])
    expect(getApp().chat.at(-1)).toMatchObject({ from: 'you', kind: 'text', text: 'What time is the meeting tomorrow?' })
    sign(word('hello'), word('friend'))
    g('handsDown')
    await settle()
    expect(getApp().chat.at(-1)).toMatchObject({ kind: 'text', text: 'Hello friend' })
    sign(word('yes'))
    g('handsDown')
    await settle()
    expect(getApp().chat.at(-1)).toMatchObject({ kind: 'text', text: 'Yes' })
    expect(captionText).toHaveBeenCalledTimes(2)
  })

  it('CALL plus one word still goes to the agent (CALL FRIEND starts a call during a captioned session)', async () => {
    const run = vi.spyOn(services, 'agentRun')
    c.setCaptioning(true)
    sendPhrase(word('call'), word('friend'))
    await settle(1000)
    // The mock interpreter reads it its own way; what matters is that it went to the agent.
    expect(run).toHaveBeenCalledTimes(1)
    expect(isCallPhrase(['friend', 'call'])).toBe(true)
    expect(isCallPhrase(['call', 'friend', 'tomorrow'])).toBe(false)
    expect(isCallPhrase(['call'])).toBe(false)
  })

  it('a quick-menu pick still goes to the agent', async () => {
    const run = vi.spyOn(services, 'agentRun')
    c.setCaptioning(true)
    c.setView({ kind: 'quickMenu', options: QUICK_MENU })
    fingers(2)
    sendPhrase(word('hello'))
    await settle(500)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps Command mode while the caption window is open: it switches to it, and swipes and the saved mode leave it', () => {
    setApp({ mode: 'spell' })
    c.setCaptioning(true)
    expect(getApp().mode).toBe('command')
    expect(getApp().view).toEqual(captionsReady)
    g('swipeRight')
    g('swipeLeft')
    expect(getApp().mode).toBe('command')
    c.restoreMode('dictation')
    expect(getApp().mode).toBe('command')
    expect(getApp().view).toEqual(captionsReady)
    c.setCaptioning(false)
    g('swipeRight')
    expect(getApp().mode).toBe('dictation')
  })

  it('closing the caption window sends phrases to the agent again', async () => {
    const run = vi.spyOn(services, 'agentRun')
    c.setCaptioning(true)
    c.setCaptioning(false)
    expect(getApp().view).toEqual({ kind: 'ready' })
    sendPhrase(word('hello'))
    await settle(500)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('the chat transcript (Command mode)', () => {
  const chat = (): ChatMessage[] => getApp().chat
  const composingWords = (): string[] => getApp().composing.tokens.map((t) => t.text)
  /** Message texts and kinds, without ids. */
  const lines = (): string[] =>
    chat().map((m) => (m.kind === 'text' ? m.text : m.kind === 'note' ? `— ${m.text} —` : m.kind === 'result' ? `[${m.answer.title}]` : `<${m.kind}>`))
  /** The live steps bubble, which is always the last one. */
  function live(): Extract<ChatMessage, { kind: 'steps' }> {
    const m = chat().at(-1)
    expect(m?.kind).toBe('steps')
    return m as Extract<ChatMessage, { kind: 'steps' }>
  }

  it('is one card in Command mode: Ready, signing, the exchange and its inline Confirm; Spell keeps its cards; a shortcut\'s Confirm stays a card', () => {
    const details = { kind: 'generic' as const, title: 't', lines: [] }
    const building: View = { kind: 'building', tokens: [word('hi')], current: 'hi', sentence: 'Hi' }
    expect(isChatCard({ kind: 'ready' }, 'command')).toBe(true)
    expect(isChatCard(building, 'command')).toBe(true)
    expect(isChatCard({ kind: 'conversation', phase: 'working', said: 'x', steps: [] }, 'command')).toBe(true)
    expect(isChatCard({ kind: 'confirm', requestId: 'q', details, inChat: true }, 'command')).toBe(true)
    expect(isChatCard({ kind: 'confirm', requestId: 'q', details }, 'command')).toBe(false)
    expect(isChatCard({ kind: 'ready' }, 'spell')).toBe(false)
    expect(isChatCard(building, 'spell')).toBe(false)
    expect(isChatCard({ kind: 'dictation', text: '' }, 'dictation')).toBe(false)
    expect(isChatCard({ kind: 'didYouMean', options: ['a'], purpose: 'sign' }, 'command')).toBe(false)
    // One width through every phase, so the window never jumps sideways.
    expect(cardWidth({ kind: 'ready' }, 'command')).toBe(340)
    expect(cardWidth(building, 'command')).toBe(340)
    expect(cardWidth({ kind: 'ready' }, 'spell')).toBe(300)
  })

  it('each recognized sign joins the composing bubble at once; swipe left takes back the last word (a letter run whole)', () => {
    c.token(word('tomorrow'))
    expect(composingWords()).toEqual(['tomorrow'])
    sign(word('meeting'), word('what'), word('time'))
    expect(composingWords()).toEqual(['tomorrow', 'meeting', 'what', 'time'])
    expect(chat()).toEqual([]) // nothing is sent while signing
    g('swipeLeft')
    expect(composingWords()).toEqual(['tomorrow', 'meeting', 'what'])
    sign(letter('K'), letter('R'))
    expect(composingWords()).toEqual(['tomorrow', 'meeting', 'what', 'K', 'R'])
    g('swipeLeft')
    expect(composingWords()).toEqual(['tomorrow', 'meeting', 'what'])
    g('swipeLeft')
    g('swipeLeft')
    g('swipeLeft')
    expect(composingWords()).toEqual([])
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(chat()).toEqual([])
  })

  it('a fist drops the words being signed: nothing is sent', () => {
    sign(word('hello'), word('there'))
    g('fist')
    expect(getApp().composing).toEqual({ tokens: [] })
    expect(chat()).toEqual([])
  })

  it('a pick in Did you mean joins the composing bubble too', () => {
    c.token(word('meeting'))
    c.ambiguousSign(['tomorrow', 'today'])
    expect(composingWords()).toEqual(['meeting'])
    fingers(1)
    expect(composingWords()).toEqual(['meeting', 'tomorrow'])
  })

  it('hands down sends: the composing bubble becomes a sent one and "Understanding" comes up; then the interpreter\'s sentence and the live steps', async () => {
    sign(...MEETING)
    g('handsDown')
    expect(getApp().composing).toEqual({ tokens: [] })
    expect(chat()).toEqual([
      { id: expect.any(String), from: 'you', kind: 'text', text: assembleSentence(MEETING) },
      { id: expect.any(String), from: 'agent', kind: 'steps', steps: [UNDERSTANDING_STEP] }
    ])
    const sentId = chat()[0].id
    await settle(500)
    // The interpreter's sentence replaces the signed words, in the same bubble.
    expect(chat()[0]).toMatchObject({ id: sentId, text: 'Meeting tomorrow at 3pm.' })
    expect(live().steps).toEqual([{ id: 's0', label: 'Opening Calendar', status: 'current' }])
    await settle(700)
    expect(live().steps.map((s) => `${s.label}:${s.status}`)).toEqual(['Opening Calendar:done', 'Creating event:current'])
    // One live bubble, updated in place.
    expect(chatShape()).toEqual(['you:text', 'agent:steps'])
  })

  it('a quick-menu pick labels the composing bubble and the sent one', async () => {
    g('thumbsUp')
    fingers(1)
    expect(getApp().composing).toEqual({ tokens: [], label: 'Create event' })
    c.token(word('meeting'))
    expect(getApp().composing).toEqual({ tokens: [word('meeting')], label: 'Create event' })
    g('handsDown')
    expect(chat()[0]).toMatchObject({ from: 'you', kind: 'text', text: 'Meeting', prefix: 'Create event' })
    expect(getApp().composing).toEqual({ tokens: [] })
  })

  it("the agent's words replace the live bubble; the reply card's next sign composes under them", async () => {
    await toReply(word('hello'))
    expect(lines()).toEqual(['Hello.', 'Hello! What can I do for you?'])
    expect(chatShape()).toEqual(['you:text', 'agent:text'])

    // A new phrase after the reply: the exchange stays, the words compose, and send as the next one.
    c.token(word('what'))
    expect(composingWords()).toEqual(['what'])
    expect(lines()).toEqual(['Hello.', 'Hello! What can I do for you?'])
    c.token(word('time'))
    expect(composingWords()).toEqual(['what', 'time'])
    g('handsDown')
    expect(chatShape()).toEqual(['you:text', 'agent:text', 'you:text', 'agent:steps'])
    await settle(1200)
    expect(lines()).toEqual(['Hello.', 'Hello! What can I do for you?', 'What time', "It's 10:00 AM on Friday, October 25."])
  })

  it('a task ends in the result bubble: the badge, the title and subtitle from the tools, the agent\'s line', async () => {
    await toWorking()
    await settle(1400)
    g('thumbsUp')
    await settle(1400)
    conversation('reply')
    expect(chat().at(-1)).toMatchObject({
      from: 'agent',
      kind: 'result',
      answer: {
        ok: true,
        title: 'Meeting created',
        subtitle: 'Tomorrow at 10:00 AM with 4 guests.',
        text: 'Team Sync is on your calendar for tomorrow at 10.',
        view: { kind: 'openApp', app: 'Calendar' }
      }
    })
    expect(chatShape()).toEqual(['you:text', 'agent:confirm', 'agent:result'])
  })

  it('a write is asked inline and nothing runs without a thumbs up; allowed, the steps come back under it', async () => {
    const respond = vi.spyOn(services, 'agentRespond')
    await toWorking()
    await settle(1400)
    const confirm = viewAs('confirm')
    expect(confirm.inChat).toBe(true)
    // The Confirm bubble takes the live bubble's place.
    expect(chatShape()).toEqual(['you:text', 'agent:confirm'])
    expect(chat().at(-1)).toMatchObject({
      kind: 'confirm',
      requestId: confirm.requestId,
      status: 'pending',
      details: { kind: 'event', title: 'Team Sync', timeLabel: '10:00 – 11:00 AM' }
    })
    // Nothing is written while it waits, whatever else the hands do.
    await settle(30_000)
    g('swipeLeft')
    g('handsDown')
    fingers(1)
    c.token(word('yes'))
    expect(respond).not.toHaveBeenCalled()
    expect(getApp().view).toBe(confirm)
    expect(chat().at(-1)).toMatchObject({ kind: 'confirm', status: 'pending' })

    g('thumbsUp')
    expect(respond).toHaveBeenCalledWith(confirm.requestId, true)
    expect(chat()[1]).toMatchObject({ kind: 'confirm', status: 'allowed' })
    expect(chatShape()).toEqual(['you:text', 'agent:confirm', 'agent:steps'])
    await settle()
    expect(live().steps.map((s) => s.status)).toEqual(['done', 'done', 'current'])
  })

  it('a fist cancels the inline Confirm: nothing is written, and the result says so', async () => {
    const respond = vi.spyOn(services, 'agentRespond')
    await toWorking()
    await settle(1400)
    const confirm = viewAs('confirm')
    g('fist')
    expect(respond).toHaveBeenCalledWith(confirm.requestId, false)
    expect(chat()[1]).toMatchObject({ kind: 'confirm', status: 'cancelled' })
    await settle()
    expect(chat().at(-1)).toMatchObject({ kind: 'result', answer: { ok: false, title: 'Nothing was done', subtitle: 'You cancelled it' } })
    expect(chatShape()).toEqual(['you:text', 'agent:confirm', 'agent:result'])
  })

  it('steps that arrive while the Confirm waits come back under it once answered; a Confirm left open when the run ends reads Cancelled', async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    const details = { kind: 'mail' as const, to: 'sam@example.com', subject: 'Hi', body: 'On my way' }
    void c.runAgent('Email Sam', 'Email Sam.')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Searching Contacts', status: 'current' } })
    emit({ type: 'confirm', runId: 'r1', requestId: 'q1', tool: 'mail_send', details })
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Searching Contacts', status: 'done' } })
    expect(chatShape()).toEqual(['you:text', 'agent:confirm'])
    c.tap('primary')
    expect(manual.agentRespond).toHaveBeenLastCalledWith('q1', true)
    expect(live().steps).toEqual([{ id: 'a', label: 'Searching Contacts', status: 'done' }])

    emit({ type: 'confirm', runId: 'r1', requestId: 'q2', tool: 'mail_send', details })
    // Main stopped waiting: the run ends with the Confirm unanswered.
    emit({ type: 'error', runId: 'r1', message: 'Timed out waiting for confirmation' })
    expect(chat()[2]).toMatchObject({ kind: 'confirm', requestId: 'q2', status: 'cancelled' })
    expect(chat().at(-1)).toMatchObject({ kind: 'error', title: "Couldn't finish", subtitle: 'Timed out waiting for confirmation' })
  })

  it('errors end the run in the error style: an agent that cannot start, or cannot finish', async () => {
    vi.spyOn(services, 'agentRun').mockResolvedValueOnce({ ok: false, error: 'nope', missingKey: 'FACTORY_API_KEY' })
    sendPhrase(word('hello'))
    await settle(500)
    expect(chat().at(-1)).toEqual({
      id: expect.any(String),
      from: 'agent',
      kind: 'error',
      title: "Couldn't start the agent",
      subtitle: 'Add FACTORY_API_KEY to .env'
    })

    const { services: manual, emit } = manualAgent(services)
    useServices(manual)
    void c.runAgent('Play music', 'Play music.')
    await settle()
    emit({ type: 'step', runId: 'r1', step: { id: 'a', label: 'Opening Spotify', status: 'current' } })
    emit({ type: 'error', runId: 'r1', message: 'Spotify is not installed' })
    expect(chat().at(-1)).toMatchObject({ kind: 'error', title: "Couldn't finish", subtitle: 'Spotify is not installed' })
    expect(chatShape()).toEqual(['you:text', 'agent:error', 'you:text', 'agent:error'])
  })

  it('a fist while the interpreter reads drops the phrase: "Cancelled" under it, and the agent never starts', async () => {
    const run = vi.spyOn(services, 'agentRun')
    sendPhrase(word('hello'))
    g('fist')
    expect(chatShape()).toEqual(['you:text', `note:${CANCELLED_NOTE}`])
    await settle(2000)
    expect(run).not.toHaveBeenCalled()
    expect(chatShape()).toEqual(['you:text', `note:${CANCELLED_NOTE}`])

    // A collapse (the chevron) drops it the same way.
    sendPhrase(word('hello'))
    c.tap('collapse')
    expect(chatShape().slice(-2)).toEqual(['you:text', `note:${CANCELLED_NOTE}`])
  })

  it('a stop: "Stopped" replaces the steps, and the next phrase starts a new exchange under it', async () => {
    await toWorking()
    await settle(700)
    g('fist')
    expect(chatShape()).toEqual(['you:text', `note:${STOPPED_NOTE}`])
    sendPhrase(word('hello'))
    await settle(1200)
    expect(lines()).toEqual(['Meeting tomorrow at 3pm.', `— ${STOPPED_NOTE} —`, 'Hello.', 'Hello! What can I do for you?'])
  })

  it('the screenshot joins its result bubble, and a click on it opens the file', async () => {
    const { services: manual, emit } = manualAgent(services)
    const openTarget = vi.fn(async () => {})
    useServices({ ...manual, openTarget, imageThumb: async () => ({ ok: true, value: MOCK_SCREENSHOT_THUMB }) })
    void c.runAgent('Take a screenshot', 'Take a screenshot.')
    await settle()
    const view = { kind: 'openFile' as const, path: MOCK_SCREENSHOT_PATH }
    const evidence = [{ tool: 'take_screenshot', args: {}, ok: true }]
    emit({ type: 'done', runId: 'r1', result: { title: 'Screenshot taken', subtitle: 'Desktop', evidence, view }, complete: true })
    // The live bubble stays while the thumbnail loads.
    expect(chatShape()).toEqual(['you:text', 'agent:steps'])
    await settle()
    const result = chat().at(-1)
    expect(result).toMatchObject({ kind: 'result', answer: { title: 'Screenshot taken', view, thumb: MOCK_SCREENSHOT_THUMB } })
    c.openChatResult(result!.id)
    expect(openTarget).toHaveBeenCalledWith(view)
  })

  it('a phrase signed as a gesture task shows with its label, and no agent bubble follows', async () => {
    c.openSettings()
    fingers(2)
    await settle()
    fingers(3) // Sign a new task
    expect(getApp().composing).toEqual({ tokens: [], label: GESTURE_TASK_LABEL })
    sendPhrase(...MEETING)
    await settle(500)
    expect(chat().map(({ id: _id, ...m }) => m)).toEqual([
      { from: 'you', kind: 'text', text: 'Schedule a meeting tomorrow at 3pm with the team', prefix: GESTURE_TASK_LABEL }
    ])
  })

  it("a gesture shortcut's agent run keeps the Working card, the Confirm card and the Stopped toast, and leaves the chat alone", async () => {
    const { services: manual, emit } = manualAgent(services)
    useServices({ ...manual, runShortcut: () => new Promise<ShortcutRunResult>(() => {}) })
    void c.runShortcut('g2', 'ready')
    emit({ type: 'started', runId: 's1', intent: 'Play Motion Sickness' })
    expect(viewAs('working').intent).toBe('Play Motion Sickness')
    emit({ type: 'step', runId: 's1', step: { id: 'a', label: 'Opening Spotify', status: 'current' } })
    emit({ type: 'confirm', runId: 's1', requestId: 'q', tool: 'x', details: { kind: 'generic', title: 't', lines: [] } })
    expect(viewAs('confirm').inChat).toBeUndefined()
    g('thumbsUp')
    expect(manual.agentRespond).toHaveBeenCalledWith('q', true)
    viewAs('working')
    g('fist')
    expect(viewAs('toast').title).toBe('Stopped')
    expect(chat()).toEqual([])
  })

  it(`keeps the session's last ${MAX_CHAT} messages, across a collapse`, async () => {
    for (let i = 0; i < 12; i++) await toReply(word('hello'))
    expect(chat()).toHaveLength(MAX_CHAT)
    expect(new Set(chat().map((m) => m.id)).size).toBe(MAX_CHAT)
    c.collapse()
    c.expand()
    expect(chat()).toHaveLength(MAX_CHAT)
    expect(chatShape().slice(-2)).toEqual(['you:text', 'agent:text'])
  })
})

describe('did you mean', () => {
  it('ambiguous sign: pick by fingers appends the chosen word', () => {
    c.token(word('meeting'))
    c.ambiguousSign(['tomorrow', 'today', 'tonight', 'Tuesday'])
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
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


  it('"Edit" on an ambiguous sign returns to the phrase', () => {
    sign(word('meeting'), word('at'))
    c.ambiguousSign(['three', 'tree'])
    c.tap('secondary')
    expect(viewAs('building')).toMatchObject({ tokens: [word('meeting'), word('at')], sentence: 'Meeting at' })
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
      options: ['KC'],
      purpose: 'spell',
      quote: 'KC',
      pending: true
    })
    await settle(300)
    expect(getApp().view).toEqual({
      kind: 'didYouMean',
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
    expect(getApp().view).toEqual({ kind: 'didYouMean', options: ['KC'], purpose: 'spell', quote: 'KC' })
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
  it('answers a greeting or a question in words, with no tool', async () => {
    const mock = mockServices()
    const done: AgentEvent[] = []
    mock.onAgentEvent((e) => e.type === 'done' && done.push(e))
    await mock.agentRun({ intent: 'Hello.', sentence: 'Hello.', frontmost: null })
    await settle(700)
    expect(done[0]).toMatchObject({ complete: false, result: { evidence: [], reply: 'Hello! What can I do for you?' } })
  })

  it('emits nothing after a stop during a pending confirmation', async () => {
    const mock = mockServices()
    const events: AgentEvent['type'][] = []
    mock.onAgentEvent((e) => events.push(e.type))
    await mock.agentRun({ intent: 'Schedule a meeting', sentence: 'Meeting.', frontmost: null })
    await settle(1400)
    expect(events.at(-1)).toBe('confirm')
    await mock.agentStop()
    await settle(5000)
    expect(events.at(-1)).toBe('stopped')
    expect(events).not.toContain('done')
  })
})

describe('shortcuts and toasts', () => {
  it('the peace sign from the pill: a toast with the screenshot, its file name and compiled meta, then back to collapsed', async () => {
    const run = vi.spyOn(services, 'runShortcut')
    const thumb = vi.spyOn(services, 'imageThumb')
    c.setView({ kind: 'collapsed' })
    c.gesture({ gesture: 'shape', shapeId: 'builtin-peace' })
    expect(run).toHaveBeenCalledWith('builtin-peace')
    await settle(400)
    expect(thumb).toHaveBeenCalledWith(MOCK_SCREENSHOT_PATH)
    expect(getApp().view).toEqual({
      kind: 'toast',
      title: 'Screenshot taken',
      subtitle: 'Desktop · fastASL Screenshot 2026-10-25 at 10.00.00.png',
      ok: true,
      meta: 'compiled · 0.4 s',
      view: { kind: 'openFile', path: MOCK_SCREENSHOT_PATH },
      thumb: MOCK_SCREENSHOT_THUMB,
      returnTo: 'collapsed'
    })
    expect(activeGestures(getApp().view)).toEqual(new Set(['thumbsUp', 'fist']))
    // Long enough to see it and raise a thumbs up.
    await settle(TOAST_THUMB_MS - 1)
    expect(getApp().view.kind).toBe('toast')
    await settle(1)
    expect(getApp().view).toEqual({ kind: 'collapsed' })
  })

  it('a thumbs up (or a click on the thumbnail) opens the screenshot in Preview, and the toast goes', async () => {
    const open = vi.spyOn(services, 'openTarget')
    c.gesture({ gesture: 'shape', shapeId: 'builtin-peace' })
    await settle(400)
    viewAs('toast')
    g('thumbsUp')
    expect(open).toHaveBeenCalledWith({ kind: 'openFile', path: MOCK_SCREENSHOT_PATH })
    expect(getApp().view).toEqual({ kind: 'ready' })

    c.gesture({ gesture: 'shape', shapeId: 'builtin-peace' })
    await settle(400)
    c.tap('primary')
    expect(open).toHaveBeenCalledTimes(2)
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('without a thumbnail (main refused it) the toast keeps the camera tile, and a thumbs up does nothing', async () => {
    const open = vi.spyOn(services, 'openTarget')
    vi.spyOn(services, 'imageThumb').mockResolvedValue({ ok: false, error: 'Not a screenshot fastASL took' })
    c.gesture({ gesture: 'shape', shapeId: 'builtin-peace' })
    await settle(400)
    const toast = viewAs('toast')
    expect(toast.thumb).toBeUndefined()
    expect(toast.view).toEqual({ kind: 'openFile', path: MOCK_SCREENSHOT_PATH })
    g('thumbsUp')
    expect(open).not.toHaveBeenCalled()
    await settle(TOAST_MS)
    expect(getApp().view).toEqual({ kind: 'ready' })
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

    it('a replay that needs a confirm shows Working and Confirm; the result is the toast, not a conversation', async () => {
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
      void c.runAgent('Open Calculator', 'Open Calculator.')
      await settle()
      finish({ ok: false, title: 'Stopped', subtitle: 'The shortcut was stopped', compiled: true, durationMs: 300 })
      await settle()
      expect(conversation('working').said).toBe('Open Calculator.')
      // Its runs are no longer adopted either.
      emit({ type: 'started', runId: 's9', intent: 'Play Motion Sickness' })
      expect(conversation('working').said).toBe('Open Calculator.')
    })

    it('a shortcut\'s fallback that announces itself before the command\'s reply is not taken for the command', async () => {
      const { manual, emit, finish } = manualShortcut()
      let reply: (value: { ok: true; value: { runId: string } }) => void = () => {}
      vi.mocked(manual.agentRun).mockImplementation(() => new Promise((resolve) => (reply = resolve)))
      c.gesture({ gesture: 'shape', shapeId: 'g2' }) // a silent compiled replay
      void c.runAgent('Text Mom on my way', 'Text Mom on my way.')
      await settle()
      // The replay failed first, so main started its agent fallback; the command then stops it.
      emit({ type: 'started', runId: 'f', intent: 'Play Motion Sickness' })
      emit({ type: 'stopped', runId: 'f' })
      emit({ type: 'started', runId: 'u', intent: 'Text Mom on my way' })
      emit({ type: 'step', runId: 'u', step: { id: 'p', label: 'Thinking', status: 'current' } })
      reply({ ok: true, value: { runId: 'u' } })
      await settle()
      expect(conversation('working')).toMatchObject({ said: 'Text Mom on my way.', steps: [{ id: 'p', label: 'Thinking', status: 'current' }] })
      emit({ type: 'confirm', runId: 'u', requestId: 'q1', tool: 'message_send', details: generic })
      viewAs('confirm')
      expect(manual.agentRespond).not.toHaveBeenCalled()
      finish({ ok: false, title: 'Stopped', subtitle: 'The shortcut was stopped', compiled: false, durationMs: 5000 })
      await settle()
      g('thumbsUp')
      expect(manual.agentRespond).toHaveBeenCalledWith('q1', true)
      emit({ type: 'done', runId: 'u', result: { title: 'Message sent', subtitle: 'to Mom', evidence: [] }, complete: true })
      expect(conversation('reply')).toMatchObject({ said: 'Text Mom on my way.', answer: { ok: true, title: 'Message sent' } })
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

  it('shows on the conversation card while the interpretation retries, and goes with the answer', async () => {
    const llm = heldLlm()
    const run = vi.spyOn(services, 'agentRun')
    sendPhrase(...MEETING)
    await settle()
    expect(llm.interprets).toHaveLength(1)
    llm.interprets[0].status(RATE_LIMITED)
    expect(getApp().notice).toBe(RATE_LIMITED)
    conversation('understanding')

    llm.interprets[0].answer({ ok: true, value: intentResult({ intent: 'Open Notes' }) })
    await settle()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ intent: 'Open Notes' }))
    expect(getApp().notice).toBeNull()
  })

  it('gives way to the final error, and the message goes to the agent anyway', async () => {
    const llm = heldLlm()
    const run = vi.spyOn(services, 'agentRun')
    sendPhrase(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    llm.interprets[0].answer({ ok: false, error: 'Gemini is rate limited. Try again in a minute' })
    await settle()
    expect(getApp().notice).toBe('Gemini is rate limited. Try again in a minute')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ intent: 'Meeting tomorrow at 3 pm' }))
    expect(conversation('working').said).toBe('Meeting tomorrow at 3 pm')
    await settle(5000)
    expect(getApp().notice).toBeNull()
  })

  it('goes when the phrase is cancelled, and the call with it', async () => {
    const llm = heldLlm()
    sendPhrase(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    g('fist')
    expect(viewAs('ready')).toBeTruthy()
    expect(getApp().notice).toBeNull()
    expect(llm.interprets[0].signal?.aborted).toBe(true)
    llm.interprets[0].status(RATE_LIMITED)
    expect(getApp().notice).toBeNull()
  })

  it('never covers another notice, and never clears it', async () => {
    const llm = heldLlm()
    sendPhrase(...MEETING)
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
    sendPhrase(...MEETING)
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

  it("a new call's status takes the place of the last call's error", async () => {
    const llm = heldLlm()
    sendPhrase(...MEETING)
    await settle()
    llm.interprets[0].status(RATE_LIMITED)
    llm.interprets[0].answer({ ok: false, error: 'Gemini is rate limited. Try again in a minute' })
    await settle()
    expect(getApp().notice).toBe('Gemini is rate limited. Try again in a minute')

    g('fist') // stops the agent the message went to
    await settle(TOAST_MS)
    expect(getApp().notice).toBe('Gemini is rate limited. Try again in a minute')
    sendPhrase(word('hello'))
    await settle()
    expect(llm.interprets).toHaveLength(2)
    llm.interprets[1].status(RATE_LIMITED)
    expect(getApp().notice).toBe(RATE_LIMITED)
    llm.interprets[1].answer({ ok: true, value: intentResult({ intent: 'Open Notes' }) })
    await settle()
    expect(getApp().notice).toBeNull()
  })

  it('cancels a call once the card drops it: cancelled or moved on from', async () => {
    const llm = heldLlm()
    sendPhrase(...MEETING)
    await settle()
    expect(llm.interprets[0].signal?.aborted).toBe(false)
    g('fist')
    expect(llm.interprets[0].signal?.aborted).toBe(true)

    sendPhrase(word('hello'))
    await settle()
    expect(llm.interprets[1].signal?.aborted).toBe(false)
    c.collapse()
    expect(llm.interprets[1].signal?.aborted).toBe(true)

    c.expand()
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
    sendPhrase(...MEETING)
    await settle()
    expect(llm.interprets).toHaveLength(1)
    expect(llm.interprets[0].signal?.aborted).toBe(false)
    llm.interprets[0].answer({ ok: true, value: intentResult({ intent: 'Open Notes' }) })
    await settle()
    conversation('working')
    g('fist')
    expect(llm.interprets[0].signal?.aborted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Guess, confirm, learn

/** identifySign answered by the test: each call waits until `answer` (or its signal aborts). */
function scriptedGuesses(base: Services, unavailable: () => string | null = () => null) {
  const calls: { req: IdentifySignRequest; signal?: AbortSignal; onStatus?: (s: string) => void; answer: (res: Result<SignGuess>) => void }[] = []
  const services: Services = {
    ...base,
    signGuessUnavailable: unavailable,
    sendsFrames: () => true,
    identifySign: vi.fn(
      (req: IdentifySignRequest, onStatus?: (s: string) => void, signal?: AbortSignal) =>
        new Promise<Result<SignGuess>>((answer) => calls.push({ req, signal, onStatus, answer }))
    )
  }
  return { services, calls }
}

/** A movement's frame vectors: 20 frames of the 136 features (values don't matter to the controller). */
const FEATURES = Array.from({ length: 20 }, (_, i) => Array.from({ length: 136 }, (_, j) => (i * 136 + j) / 1e4 + 1e-5))
const MOVEMENT: UnknownMovement = { frames: ['/9j/A=', '/9j/B=', '/9j/C='], motion: '1.0 s, one hand.', features: FEATURES }
const HELLO_GUESS: SignGuess = {
  is_sign: true,
  candidates: [
    { gloss: 'HELLO', confidence: 0.8, hands: 1 },
    { gloss: 'HI', confidence: 0.4, hands: 1 },
    { gloss: 'GOODBYE', confidence: 0.2, hands: 1 }
  ]
}
const LEARN_LIST: View = { kind: 'didYouMean', options: ['HELLO', 'HI', 'GOODBYE'], purpose: 'learn' }

describe('guess, confirm, learn', () => {
  let guesses: ReturnType<typeof scriptedGuesses>

  beforeEach(() => {
    guesses = scriptedGuesses(mockServices())
    useServices(guesses.services)
  })

  /** A movement nothing taught matched, as recognition reports it: Listening, rejected, then the guess. */
  const unknown = (movement: UnknownMovement = MOVEMENT): void => {
    c.signStart()
    c.signRejected()
    c.unknownSign(movement)
  }
  const answer = async (res: Result<SignGuess>, call = guesses.calls.length - 1): Promise<void> => {
    guesses.calls[call].answer(res)
    await settle()
  }

  it('in Ready: Listening ends, "Identifying sign..." shows, then "Is this HELLO?" with up to 3 options', async () => {
    setApp({
      templates: [
        { id: 'y', label: 'YES', kind: 'word', frames: [], createdAt: 0 },
        { id: 'a', label: 'A', kind: 'letter', frames: [], createdAt: 0 }
      ]
    })
    unknown()
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().notice).toBe(IDENTIFYING)
    expect(guesses.calls[0].req).toEqual({ frames: MOVEMENT.frames, motion: MOVEMENT.motion, mode: 'command', known: ['YES'] })
    await answer({ ok: true, value: HELLO_GUESS })
    expect(getApp().view).toEqual(LEARN_LIST)
    expect(getApp().notice).toBeNull()
    expect(activeGestures(getApp().view)).toEqual(new Set(['fingers', 'fist', 'thumbsUp']))
  })

  it('a one-handed sign is learned without the other hand in view; a two-handed one keeps both', async () => {
    // Both hands seen throughout; the right one (slot 0) moves, the left barely does.
    const frames = Array.from({ length: 20 }, (_, i) => {
      const f = new Array<number>(FRAME_FEATURE_DIM).fill(0.5)
      f[0] = 1
      f[HAND_FEATURE_DIM] = 1
      f[65] = 1.2 * (i % 2 ? 1 : -1)
      f[66] = 0.9
      f[HAND_FEATURE_DIM + 65] = 0.03
      f[HAND_FEATURE_DIM + 66] = 0
      return f
    })
    unknown({ ...MOVEMENT, features: frames })
    await answer({ ok: true, value: HELLO_GUESS }) // HELLO: one hand
    g('thumbsUp')
    await settle()
    const one = api.saveTemplates.mock.calls[0][0].templates[0].frames
    expect(one.every((f: number[]) => f.slice(HAND_FEATURE_DIM).every((v) => v === 0))).toBe(true)
    expect(one[0][0]).toBe(1)

    await settle(SIGN_GUESS_COOLDOWN_MS)
    unknown({ ...MOVEMENT, features: frames })
    await answer({ ok: true, value: { is_sign: true, candidates: [{ gloss: 'MEETING', confidence: 0.8, hands: 2 }] } })
    g('thumbsUp')
    await settle()
    const calls = api.saveTemplates.mock.calls
    const meeting = calls[calls.length - 1][0].templates.find((tp: { label: string }) => tp.label === 'MEETING')
    expect(meeting!.frames[0][HAND_FEATURE_DIM]).toBe(1)
  })

  it('a pick adds the word as a recognized sign would, and learns that movement as it (saved, recognition reloads)', async () => {
    unknown()
    await answer({ ok: true, value: HELLO_GUESS })
    g('thumbsUp') // = option 1
    expect(getApp().view).toEqual({ kind: 'recognizing', token: 'hello', isWord: true })
    await settle()
    const saved = api.saveTemplates.mock.calls[0][0].templates
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ label: 'HELLO', kind: 'word' })
    expect(saved[0].frames).toHaveLength(32)
    expect(saved[0].frames[0][0]).toBe(Math.round(saved[0].frames[0][0] * 1000) / 1000)
    expect(getApp().templates).toEqual(saved) // recognition follows the store
    expect(getApp().notice).toBe('Learned HELLO')
    // No toast: the phrase carries on, and the next sign builds on it.
    c.token(word('tomorrow'))
    expect(viewAs('building').tokens).toEqual([word('hello'), word('tomorrow')])
  })

  it('while building a phrase: a pick by fingers joins the phrase; a fist learns nothing and the phrase carries on', async () => {
    sign(word('meeting'))
    c.token(word('tomorrow'))
    const building = viewAs('building')
    unknown()
    expect(getApp().view).toBe(building)
    await answer({ ok: true, value: HELLO_GUESS })
    fingers(2)
    expect(viewAs('building').tokens).toEqual([word('meeting'), word('tomorrow'), word('hi')])
    await settle()
    expect(api.saveTemplates.mock.calls[0][0].templates[0]).toMatchObject({ label: 'HI' })

    await settle(SIGN_GUESS_COOLDOWN_MS)
    const before = viewAs('building')
    unknown()
    await answer({ ok: true, value: HELLO_GUESS })
    g('fist')
    expect(getApp().view).toBe(before)
    expect(api.saveTemplates).toHaveBeenCalledTimes(1)
    c.token(word('3'))
    expect(viewAs('building').tokens.map((t) => t.text)).toEqual(['meeting', 'tomorrow', 'hi', '3'])
  })

  it('a guess still running when the phrase is sent is dropped: the message goes without it', async () => {
    sign(word('meeting'))
    c.token(word('tomorrow'))
    unknown()
    g('handsDown')
    expect(conversation('understanding').said).toBe('Meeting tomorrow')
    expect(guesses.calls[0].signal?.aborted).toBe(true)
    await answer({ ok: true, value: HELLO_GUESS })
    conversation('understanding')
  })

  it("on the agent's reply: a guess is asked, and the pick starts the next message with the word", async () => {
    const reply: View = { kind: 'conversation', phase: 'reply', said: 'Hello.', steps: [], answer: { ok: true, text: 'Hi!' } }
    c.setView(reply)
    unknown()
    await answer({ ok: true, value: HELLO_GUESS })
    expect(getApp().view).toEqual(LEARN_LIST)
    g('fist')
    expect(getApp().view).toBe(reply)
    await settle(SIGN_GUESS_COOLDOWN_MS)
    unknown()
    await answer({ ok: true, value: HELLO_GUESS })
    fingers(2)
    expect(viewAs('recognizing').token).toBe('hi')
    g('handsDown')
    expect(conversation('understanding').said).toBe('Hi')
  })

  it('the X and Edit also decline', async () => {
    unknown()
    await answer({ ok: true, value: HELLO_GUESS })
    c.tap('close')
    expect(getApp().view).toEqual({ kind: 'ready' })
    await settle(SIGN_GUESS_COOLDOWN_MS)
    unknown()
    await answer({ ok: true, value: HELLO_GUESS })
    c.tap('secondary')
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(api.saveTemplates).not.toHaveBeenCalled()
  })

  it('a guess of a word already taught adds this movement to its templates', async () => {
    const taught = [1, 2].map((n) => ({ id: `HELLO-${n}`, label: 'HELLO', kind: 'word' as const, frames: [], createdAt: n }))
    api.getTemplates.mockResolvedValue({ version: 1, templates: taught })
    setApp({ templates: taught })
    unknown()
    expect(guesses.calls[0].req.known).toEqual(['HELLO'])
    await answer({ ok: true, value: HELLO_GUESS })
    fingers(1)
    await settle()
    expect(getApp().templates.filter((t) => t.label === 'HELLO')).toHaveLength(3)
  })

  it('in Dictation: a pick types the word like a recognized sign', async () => {
    const typeText = vi.spyOn(guesses.services, 'typeText')
    setApp({ mode: 'dictation' })
    c.setView({ kind: 'dictation', text: 'see you' })
    c.unknownSign(MOVEMENT)
    expect(guesses.calls[0].req.mode).toBe('dictation')
    await answer({ ok: true, value: HELLO_GUESS })
    fingers(1)
    expect(getApp().view).toEqual({ kind: 'dictation', text: 'see you hello' })
    expect(typeText).toHaveBeenCalledWith(' hello')
  })

  it('"not a sign" carries on quietly, as for any movement nothing matched', async () => {
    unknown()
    await answer({ ok: true, value: { is_sign: false, candidates: [] } })
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().notice).toBeNull()
  })

  it('one call at a time, and a cooldown of 3 s between them', async () => {
    unknown()
    unknown() // in flight: rejected as before
    expect(guesses.calls).toHaveLength(1)
    expect(getApp().view).toEqual({ kind: 'ready' })
    await answer({ ok: true, value: { is_sign: false, candidates: [] } })
    unknown() // answered at once, but the cooldown runs from the start
    expect(guesses.calls).toHaveLength(1)
    await settle(SIGN_GUESS_COOLDOWN_MS)
    unknown()
    expect(guesses.calls).toHaveLength(2)
  })

  it('is superseded (and cancelled in main) by a sign recognized meanwhile, a control gesture or a mode switch', async () => {
    unknown()
    c.token(word('hello'))
    expect(guesses.calls[0].signal?.aborted).toBe(true)
    await answer({ ok: true, value: HELLO_GUESS }, 0)
    expect(viewAs('recognizing').token).toBe('hello')
    expect(getApp().notice).toBeNull()

    c.expand()
    await settle(SIGN_GUESS_COOLDOWN_MS)
    unknown()
    g('thumbsUp') // the quick menu
    expect(guesses.calls[1].signal?.aborted).toBe(true)
    await answer({ ok: true, value: HELLO_GUESS }, 1)
    expect(viewAs('quickMenu').options).toEqual(QUICK_MENU)

    c.expand()
    await settle(SIGN_GUESS_COOLDOWN_MS)
    unknown()
    c.cycleMode(1)
    expect(guesses.calls[2].signal?.aborted).toBe(true)
  })

  it('survives the hands moving on (Listening and back), which is no new phrase', async () => {
    unknown()
    c.signStart()
    c.signRejected()
    expect(guesses.calls[0].signal?.aborted).toBe(false)
    c.signStart() // still moving when the answer comes: the list replaces Listening, and goes back to Ready
    await answer({ ok: true, value: HELLO_GUESS })
    expect(getApp().view).toEqual(LEARN_LIST)
    g('fist')
    expect(getApp().view).toEqual({ kind: 'ready' })
  })

  it('a failure falls back to a rejected movement, saying why at most once a minute', async () => {
    unknown()
    await answer({ ok: false, error: 'Gemini is rate limited. Try again in 51 s' })
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().notice).toBe('Gemini is rate limited. Try again in 51 s')
    await settle(5000)
    expect(getApp().notice).toBeNull()
    unknown()
    await answer({ ok: false, error: 'Gemini is rate limited. Try again in 40 s' })
    expect(getApp().notice).toBeNull()
    await settle(SIGN_GUESS_ERROR_EVERY_MS)
    unknown()
    await answer({ ok: false, error: 'Can\'t reach Gemini. Check your connection' })
    expect(getApp().notice).toBe("Can't reach Gemini. Check your connection")
  })

  it('a bridge that throws is a failed guess, not a stuck one', async () => {
    const identifySign = vi.fn(() => {
      throw new TypeError('api.identifySign is not a function')
    })
    useServices({ ...guesses.services, identifySign })
    unknown()
    await settle()
    expect(getApp().notice).toBe('api.identifySign is not a function')
    await settle(SIGN_GUESS_COOLDOWN_MS)
    expect(c.guessesSigns()).toBe(true)
  })

  it('a rate-limit status replaces "Identifying sign..." while the call retries', async () => {
    unknown()
    guesses.calls[0].onStatus?.('Rate limited, retrying...')
    expect(getApp().notice).toBe('Rate limited, retrying...')
    await answer({ ok: true, value: HELLO_GUESS })
    expect(getApp().notice).toBeNull()
  })

  it('never guesses without an LLM, in Spell mode, or while a message is with the interpreter or the agent', async () => {
    const off = scriptedGuesses(mockServices(), () => 'Add GEMINI_API_KEY to .env')
    useServices(off.services)
    unknown()
    expect(off.calls).toHaveLength(0)
    expect(getApp().view).toEqual({ kind: 'ready' })
    expect(getApp().notice).toBeNull()
    expect(c.guessesSigns()).toBe(false)
    expect(c.wantsSignFrames()).toBe(false)

    useServices(guesses.services)
    setApp({ mode: 'spell' })
    c.setView({ kind: 'ready' })
    expect(c.guessesSigns()).toBe(false)
    expect(c.wantsSignFrames()).toBe(false)
    setApp({ mode: 'command' })
    c.setView({ kind: 'conversation', phase: 'understanding', said: 'Hi', steps: [] })
    expect(c.guessesSigns()).toBe(false)
    c.setView({ kind: 'conversation', phase: 'working', said: 'Hi', steps: [] })
    expect(c.guessesSigns()).toBe(false)
    c.setView({ kind: 'collapsed' })
    expect(c.guessesSigns()).toBe(false)
    expect(c.wantsSignFrames()).toBe(false)
    c.setView({ kind: 'ready' })
    expect(c.guessesSigns()).toBe(true)
    expect(c.wantsSignFrames()).toBe(true)
  })

  it('the mock services never want frames (they never look at them)', () => {
    useServices(mockServices())
    expect(c.guessesSigns()).toBe(true)
    expect(c.wantsSignFrames()).toBe(false)
  })
})

describe('Teach › Show me a sign', () => {
  let guesses: ReturnType<typeof scriptedGuesses>
  const show = (phase: 'waiting' | 'listening' | 'identifying', reason?: string): View => ({
    kind: 'settings',
    settings: { page: 'teachShow', phase, ...(reason ? { reason } : {}) }
  })

  beforeEach(() => {
    guesses = scriptedGuesses(mockServices())
    useServices(guesses.services)
  })

  const open = (): void => {
    c.openSettings()
    fingers(1) // Teach a sign
    expect(optionsFor(getApp().view)[0]).toBe(SHOW_ME)
    fingers(1) // Show me a sign
  }
  const answer = async (res: Result<SignGuess>, call = guesses.calls.length - 1): Promise<void> => {
    guesses.calls[call].answer(res)
    await settle()
  }

  it('is the first option of the Teach page; it waits, listens, identifies, then asks "Is this HELLO?"', async () => {
    open()
    expect(getApp().view).toEqual(show('waiting'))
    expect(activeGestures(getApp().view)).toEqual(new Set(['fist']))
    c.showSignListening()
    expect(getApp().view).toEqual(show('listening'))
    c.showSign(MOVEMENT)
    expect(getApp().view).toEqual(show('identifying'))
    expect(guesses.calls[0].req).toMatchObject({ frames: MOVEMENT.frames, motion: MOVEMENT.motion })
    await answer({ ok: true, value: HELLO_GUESS })
    expect(viewAs('settings').settings).toEqual({ page: 'teachShow', phase: 'guess', guesses: ['HELLO', 'HI', 'GOODBYE'] })
    expect(optionsFor(getApp().view)).toEqual(['HELLO', 'HI', 'GOODBYE', NONE_OF_THESE])
    expect(activeGestures(getApp().view)).toEqual(new Set(['fingers', 'thumbsUp', 'fist']))
    // A new screen: a shape still held from the sign can't pick.
    expect(gestureScreen(getApp().view)).not.toBe(gestureScreen(show('waiting')))
  })

  it('a pick learns that one repetition as the word: "Learned HELLO", then the list on its page', async () => {
    open()
    c.showSign(MOVEMENT)
    await answer({ ok: true, value: HELLO_GUESS })
    g('thumbsUp')
    await settle()
    expect(viewAs('toast')).toMatchObject({ title: 'Learned HELLO', subtitle: '1 recording saved', ok: true })
    const saved = api.saveTemplates.mock.calls[0][0].templates
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ label: 'HELLO', kind: 'word' })
    expect(saved[0].frames).toHaveLength(32)
    await settle(TOAST_MS)
    expect(viewAs('settings').settings).toEqual({ page: 'teachPick', offset: 0, recorded: { HELLO: 1 } })
  })

  it('"None of these" leads to the list; a fist goes back from every step', async () => {
    open()
    c.showSign(MOVEMENT)
    await answer({ ok: true, value: HELLO_GUESS })
    fingers(4)
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick', offset: 0 })
    expect(api.saveTemplates).not.toHaveBeenCalled()

    fingers(1)
    c.showSign(MOVEMENT)
    await answer({ ok: true, value: HELLO_GUESS })
    g('fist')
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick' })

    fingers(1)
    c.showSign(MOVEMENT)
    g('fist') // while identifying: the call is cancelled
    expect(guesses.calls[2].signal?.aborted).toBe(true)
    await answer({ ok: true, value: HELLO_GUESS }, 2)
    expect(viewAs('settings').settings).toMatchObject({ page: 'teachPick' })
  })

  it('says why when there is no guess, and waits for another try', async () => {
    open()
    c.showSign(MOVEMENT)
    await answer({ ok: true, value: { is_sign: false, candidates: [] } })
    expect(getApp().view).toEqual(show('waiting', NOT_A_SIGN))
    c.showSignListening()
    expect(getApp().view).toEqual(show('listening'))
    c.showSignEnded('Too long. Sign it once, then hold still.')
    expect(getApp().view).toEqual(show('waiting', 'Too long. Sign it once, then hold still.'))
    c.showSign(MOVEMENT)
    await answer({ ok: false, error: 'Gemini is busy right now. Try again in a moment' })
    expect(getApp().view).toEqual(show('waiting', 'Gemini is busy right now. Try again in a moment'))
  })

  it('without an LLM it says what to add, and sends nothing', () => {
    const off = scriptedGuesses(mockServices(), () => 'Add GEMINI_API_KEY to .env')
    useServices(off.services)
    open()
    expect(getApp().view).toEqual(show('waiting', 'Add GEMINI_API_KEY to .env'))
    c.showSign(MOVEMENT)
    expect(off.calls).toHaveLength(0)
    expect(getApp().view).toEqual(show('waiting', 'Add GEMINI_API_KEY to .env'))
  })

  it('ignores recorder updates elsewhere', () => {
    const root: View = { kind: 'settings', settings: { page: 'root' } }
    c.setView(root)
    c.showSignListening()
    c.showSignEnded('x')
    c.showSign(MOVEMENT)
    expect(getApp().view).toBe(root)
    expect(guesses.calls).toHaveLength(0)
  })
})
