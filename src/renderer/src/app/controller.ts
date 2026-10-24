import { mergeTemplates } from '@shared/templatePack'
import type {
  AgentEvent,
  AgentResult,
  AgentStep,
  CameraSource,
  CustomGesture,
  EnvKey,
  IdentifySignRequest,
  IntentResult,
  Mode,
  Result,
  ShortcutRunResult,
  SignGuess,
  SignTemplate
} from '@shared/types'
import { CAPTURE_REASONS, type ShapeCapture } from '../engine/gestures/customShapes'
import { dominantSlot, keepActiveHand } from '../engine/recognition/features'
import { wordTemplate } from '../engine/recognition/teach'
import { getApp, setApp } from './store'
import type { Services } from './services'
import type { SettingsPage, Token, View } from './types'
import { live } from './live'

type HoldPage = Extract<SettingsPage, { page: 'newGestureHold' }>

/** Hands-only control gestures produced by the gesture engine (Phase 3) or dev hotkeys. */
export type GestureName =
  | 'palmHold'
  | 'swipeLeft'
  | 'swipeRight'
  | 'swipeUp'
  | 'thumbsUp'
  | 'fist'
  | 'fingers'
  | 'handsDown'
  | 'shape'

export interface GestureInput {
  gesture: GestureName
  /** For 'fingers': 1..5. */
  count?: number
  /** For 'shape': the custom gesture id. */
  shapeId?: string
}

/** Mouse / trackpad taps on card controls map onto the same actions as gestures. */
export type TapTarget =
  | 'primary'
  | 'secondary'
  | 'close'
  | 'collapse'
  | 'expand'
  | 'camera'
  | 'proceed'
  | 'option'
  | 'settings'

export const QUICK_MENU = ['Create event', 'Send message', 'Search web', 'Take notes', 'Open app']
export const SETTINGS_ROOT = ['Teach a sign', 'New gesture', 'My gestures', 'Camera source', 'Sensitivity']
const MODES: Mode[] = ['command', 'dictation', 'spell']

const DONE_AUTO_COLLAPSE_MS = 4000
const TOAST_MS = 2600
/** Why typing failed (often a permission to grant in System Settings) needs time to read. */
const TYPING_NOTICE_MS = 8000
/** The dictation card keeps this much of the typed text (it shows the last two lines). */
const DICTATION_KEEP = 120
/** Typed text continues a run (spaced from it) this long after the last typing, card or not. */
const TYPED_RUN_MS = 2 * 60_000

/** Below this Claude is guessing, so the card always asks (Did you mean). */
const LOW_CONFIDENCE = 0.6
/** Below this, listed alternatives are close enough to the intent to ask too. */
const CLOSE_CALL = 0.75
const INSERT_TEXT = 'Insert text'
const MORE_OPTIONS = 'More options'
/** Claude's app-specific actions shown between Insert text and More options (4 rows, 4 fingers). */
const MAX_SUGGESTED_ACTIONS = 2

/** New gesture › hold: 3, 2, 1, then app/shapeInput records the shape (CAPTURE_MS). */
const COUNTDOWN_FROM = 3
const COUNTDOWN_TICK_MS = 1000
/** No verdict this long into a recording means no camera frames came (camera off or failed). */
const CAPTURE_TIMEOUT_MS = 2500
const SIGN_TASK_HINT = 'Sign the task for your gesture'
/** Gestures per page of My gestures (two-line rows). */
export const GESTURE_PAGE = 4
/** What Settings › Camera source accepts as a stream URL (the proxy checks the rest). */
const STREAM_URL = /^https?:\/\/\S+$/i
/** Why a stream gave way to the MacBook camera: long enough to read. */
const CAMERA_FALLBACK_NOTICE_MS = 8000
const BUILTIN_CAMERA: CameraSource = { kind: 'builtin' }
export const cameraFallbackNotice = (error: string): string => `${error}. Using the MacBook camera.`

/** Guess, confirm, learn: one identifySign call at a time, and at least this long between them. */
export const SIGN_GUESS_COOLDOWN_MS = 3000
/** Why a guess failed (no key, a rate limit) is shown at most this often, so it doesn't nag. */
export const SIGN_GUESS_ERROR_EVERY_MS = 60_000
/** The notice while the LLM looks at a movement. */
export const IDENTIFYING = 'Identifying sign...'
/** Teach a sign: the first option on every page of the list. */
export const SHOW_ME = 'Show me a sign'
/** Teach › Show me a sign: after the guesses, the list-based teaching. */
export const NONE_OF_THESE = 'None of these: pick from list'
export const NOT_A_SIGN = "That didn't look like a sign. Try again."

/**
 * A movement no taught word matched, ready to be guessed: camera frames across it (none on the
 * mock provider), what hand tracking measured, and its frame vectors, which become the word's
 * template when the user confirms a guess.
 */
export interface UnknownMovement {
  frames: string[]
  motion: string
  features: number[][]
}

/**
 * A confirmed guess's movement as it is learned: a one-handed sign (by the LLM's account) keeps
 * only the signing hand (the user's dominant one when known), so the other hand in view isn't
 * expected next time.
 */
function learnedFrames(features: number[][], hands: 1 | 2 | undefined): number[][] {
  return hands === 1 ? keepActiveHand(features, dominantSlot(getApp().templates)) : features
}

/** The word labels taught so far, which a guess may name. */
function taughtWords(templates: readonly SignTemplate[]): string[] {
  return [...new Set(templates.filter((t) => t.kind === 'word').map((t) => t.label))]
}

const isInsertAction = (action: string): boolean => /\b(insert|type)\b/i.test(action)
const isMoreAction = (action: string): boolean => /\bmore\b/i.test(action)

/** Insert text and More options are always offered, whatever Claude suggested for the app. */
function contextActionsFor(suggested: string[]): string[] {
  const own = suggested.filter((a) => !isInsertAction(a) && !isMoreAction(a)).slice(0, MAX_SUGGESTED_ACTIONS)
  return [INSERT_TEXT, ...own, MORE_OPTIONS]
}

/** The agent run on the card. Only its events are shown; anything else is stale. */
interface AgentRunState {
  /**
   * A command's run is null until agentRun replies; its events wait in `held` until then. A 'started'
   * can't name it: a run main queued earlier (a shortcut's agent fallback) may announce itself first.
   */
  runId: string | null
  intent: string
  /** Run by a gesture shortcut: the shortcut's toast shows the result, not the Done card. */
  shortcut: boolean
  held: AgentEvent[]
}

/** Outcome of one Claude interpretation. Errors are carried per request, never shared. */
interface Interpretation {
  result: IntentResult | null
  error: string | null
}

/** One-line message for a soft service failure. */
function failureText(failure: { error: string; missingKey?: EnvKey }): string {
  return failure.missingKey ? `Add ${failure.missingKey} to .env` : failure.error
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** IPC calls can also reject (main-process crash); treat that as a soft failure too. */
function settled<T>(call: Promise<Result<T>>): Promise<Result<T>> {
  return call.catch((err: unknown) => ({ ok: false as const, error: errorText(err) }))
}

/** Join recognized tokens into display text. Consecutive letters form one word. */
export function assembleSentence(tokens: Token[]): string {
  const words: string[] = []
  let spelled = ''
  for (const t of tokens) {
    if (t.kind === 'letter') {
      spelled += t.text
      continue
    }
    if (spelled) words.push(spelled)
    spelled = ''
    words.push(t.text)
  }
  if (spelled) words.push(spelled)
  const text = words.join(' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

/**
 * What Dictation types for a sign, given the kind of sign typed before it (null for the first).
 * Words are separated by a space and a run of letters is one word. The space goes before a
 * word, never after it, so punctuation typed by hand lands right after the last word.
 */
export function dictationChunk(previous: Token['kind'] | null, token: Token): string {
  const joined = previous === null || (previous === 'letter' && token.kind === 'letter')
  return joined ? token.text : ` ${token.text}`
}

/** Listening: a movement started in Ready and nothing is recognized yet. */
function isListening(view: View): boolean {
  return view.kind === 'recognizing' && view.token === null
}

/**
 * Where a guessed sign can start and land: the views that add a recognized sign to the phrase
 * (or type it, in Dictation). Not the Sentence card while it is being proceeded.
 */
function guessView(view: View): boolean {
  switch (view.kind) {
    case 'ready':
    case 'recognizing':
    case 'building':
    case 'dictation':
      return true
    case 'sentence':
      return !view.thinking
    default:
      return false
  }
}

/** Teach › Show me a sign, waiting for (or hearing) its one repetition. */
export function showsSign(view: View): boolean {
  if (view.kind !== 'settings' || view.settings.page !== 'teachShow') return false
  return view.settings.phase === 'waiting' || view.settings.phase === 'listening'
}

/** Which gestures make sense in each view (and mode). The gesture engine ignores the rest. */
export function activeGestures(view: View, mode: Mode = 'command'): Set<GestureName> {
  switch (view.kind) {
    case 'collapsed':
      return new Set(['palmHold', 'shape'])
    case 'ready':
      // The quick menu prefixes commands: Spell mode has none (and an ASL A is close to a thumbs up).
      if (mode === 'spell') return new Set(['fist', 'swipeLeft', 'swipeRight', 'swipeUp', 'shape'])
      return new Set(['thumbsUp', 'fist', 'swipeLeft', 'swipeRight', 'swipeUp', 'shape'])
    case 'recognizing':
      // Raising a hand to make a control gesture is a movement too: Listening keeps Ready's gestures.
      if (isListening(view)) return activeGestures({ kind: 'ready' }, mode)
      return new Set(['thumbsUp', 'fist', 'swipeLeft', 'swipeRight', 'handsDown'])
    case 'building':
      return new Set(['thumbsUp', 'fist', 'swipeLeft', 'swipeRight', 'handsDown'])
    case 'sentence':
      return new Set(['thumbsUp', 'fist', 'swipeLeft', 'swipeRight'])
    case 'agentReady':
      return new Set(['thumbsUp', 'fist', 'swipeLeft'])
    case 'working':
      return new Set(['fist'])
    case 'confirm':
      return new Set(['thumbsUp', 'fist'])
    case 'didYouMean':
      if (view.variant === 'quote') return new Set(['thumbsUp', 'fist', 'swipeLeft'])
      // Swipe left edits what the list was made from: the sentence, or the spelled letters.
      if (view.purpose === 'sign' || view.purpose === 'learn') return new Set(['fingers', 'fist', 'thumbsUp'])
      return new Set(['fingers', 'fist', 'thumbsUp', 'swipeLeft'])
    case 'done':
      return new Set(['thumbsUp', 'fist', 'fingers', 'swipeUp'])
    case 'contextActions':
    case 'quickMenu':
      return new Set(['fingers', 'fist'])
    case 'dictation':
      return new Set(['fist', 'swipeLeft', 'swipeRight', 'swipeUp'])
    case 'toast':
      return new Set(['fist'])
    case 'settings':
      switch (view.settings.page) {
        case 'teachSpell':
          return new Set(['thumbsUp', 'fist', 'swipeLeft'])
        case 'teachRecord':
          // Letters are held still and S, T, M, N read as a fist: a swipe goes back instead.
          return new Set([view.settings.kind === 'letter' ? 'swipeLeft' : 'fist'])
        case 'teachShow':
          // The sign itself may show fingers or a thumbs up: those pick only once there are guesses.
          return new Set(view.settings.phase === 'guess' ? ['fingers', 'thumbsUp', 'fist'] : ['fist'])
        case 'newGestureHold':
          // The new shape may read as a fist (or a thumbs up) while it is formed: until a recording
          // is refused, only a swipe goes back.
          return new Set(view.settings.reason ? ['thumbsUp', 'fist', 'swipeLeft'] : ['swipeLeft'])
        case 'camera':
          // Hands typing the URL can read as a fist or a finger count: while the field is open,
          // only a swipe closes it.
          return new Set(view.settings.editing ? ['swipeLeft'] : ['fingers', 'fist', 'swipeLeft', 'swipeRight'])
        default:
          return new Set(['fingers', 'fist', 'swipeLeft', 'swipeRight'])
      }
  }
}

/**
 * The screen a view counts as when a new one must not inherit a gesture already shown
 * (gestureInput spends them). Listening is still Ready, so a fist raised into view, which
 * starts a movement and shows Listening, can still collapse the card. A refused shape is
 * its own screen: the shape (a thumbs up, a fist) is often still held as the reason appears.
 */
export function gestureScreen(view: View): string {
  if (isListening(view)) return 'ready'
  if (view.kind === 'settings' && view.settings.page === 'newGestureHold') {
    return view.settings.reason ? 'shapeRefused' : 'shapeHold'
  }
  // The guesses come up while the hand may still hold the sign's last shape (two fingers, say).
  if (view.kind === 'settings' && view.settings.page === 'teachShow') return `teachShow:${view.settings.phase}`
  return view.kind
}

/** New gesture › hold is recording the shape (app/shapeInput feeds it the camera frames). */
export function isCapturingShape(view: View): view is { kind: 'settings'; settings: HoldPage } {
  return view.kind === 'settings' && view.settings.page === 'newGestureHold' && view.settings.countdown === 0 && !view.settings.reason
}

/** Views that take signs from recognition. Teach › record feeds its own recorder instead. */
export function takesSigns(view: View): boolean {
  switch (view.kind) {
    case 'ready':
    case 'recognizing':
    case 'building':
    case 'sentence':
    case 'dictation':
      return true
    case 'settings':
      return view.settings.page === 'teachSpell'
    default:
      return false
  }
}

/** Options listed (and numbered) in the current view, for finger-count picking. */
export function optionsFor(view: View): string[] {
  switch (view.kind) {
    case 'didYouMean':
      return view.options
    case 'contextActions':
      return view.actions
    case 'quickMenu':
      return view.options
    case 'done':
      // Only a completed task can become a gesture shortcut.
      return view.ok ? ['View', 'New command', 'Save as gesture'] : ['View', 'New command']
    case 'settings':
      return settingsOptions(view.settings)
    default:
      return []
  }
}

export const STARTER_WORDS = [
  'YES', 'NO', 'HELLO', 'MEETING', 'TOMORROW', 'TIME', 'NEXT', 'WHAT',
  'SEND', 'EMAIL', 'TEXT', 'FRIEND', 'PLAY', 'MUSIC', 'CALENDAR', 'GOOD'
]
export const LETTERS = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('')
const TEACH_LABELS = [...STARTER_WORDS, ...LETTERS]
/** Signs per page of the teach list: with Show me a sign and Spell a new word, five rows (fingers 1-5). */
export const TEACH_PAGE = 3
/** Repetitions recorded per sign (TeachSession defaults). */
const TEACH_REPS = { word: 5, letter: 5 } as const
const MAX_TEACH_WORD = 32

/** Recorded templates per label (one per kept repetition). */
export function countSigns(templates: readonly SignTemplate[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of templates) counts[t.label] = (counts[t.label] ?? 0) + 1
  return counts
}

const hasLetters = (templates: readonly SignTemplate[]): boolean => templates.some((t) => t.kind === 'letter')

export function settingsOptions(page: SettingsPage): string[] {
  switch (page.page) {
    case 'root':
      return SETTINGS_ROOT
    case 'teachPick':
      return [SHOW_ME, ...TEACH_LABELS.slice(page.offset, page.offset + TEACH_PAGE), 'Spell a new word']
    case 'teachShow':
      return page.phase === 'guess' ? [...(page.guesses ?? []), NONE_OF_THESE] : []
    case 'newGesturePick':
      return [...page.tasks.slice(0, 4), 'Sign a new task']
    case 'gestures':
      return page.gestures.slice(page.offset, page.offset + GESTURE_PAGE).map((g) => g.name)
    case 'gestureDetail':
      return page.gesture.builtin ? ['Test it'] : ['Test it', 'Delete']
    case 'camera':
      return ['MacBook camera', 'ESP32-CAM stream', 'Edit stream URL']
    case 'sensitivity':
      return ['Low', 'Medium', 'High']
    default:
      return []
  }
}

/** "Gesture 2", "Gesture 3"…: the first number no saved gesture uses (the peace sign is gesture 1). */
export function nextGestureName(gestures: readonly Pick<CustomGesture, 'name'>[]): string {
  const names = new Set(gestures.map((g) => g.name))
  let n = 2
  while (names.has(`Gesture ${n}`)) n++
  return `Gesture ${n}`
}

/** My gestures, on the page showing `focusId` (the first page without one). */
function gestureList(gestures: readonly CustomGesture[], focusId?: string): SettingsPage {
  const index = Math.max(0, gestures.findIndex((g) => g.id === focusId))
  return {
    page: 'gestures',
    gestures: gestures.map(({ id, name, task, builtin }) => ({ id, name, task, builtin })),
    offset: index - (index % GESTURE_PAGE)
  }
}

/** The one place where card states change. */
export class Controller {
  private tokens: Token[] = []
  private intentPrefix: string | undefined
  /** New gesture › Sign a new task: the phrase signed next becomes the gesture's task, not an agent run. */
  private signingTask = false
  private interpretation: Promise<Interpretation> | null = null
  private steps: AgentStep[] = []
  /** From runAgent (or a shortcut's run starting) until done / error / stop. */
  private agentRun: AgentRunState | null = null
  /** The shortcut waiting on the main process; a newer run or a stop abandons it (no toast). */
  private shortcut: Promise<ShortcutRunResult> | null = null
  /** The run behind the Stopped toast: main still reports a write it had already made. */
  private stopped: { runId: string; toast: View } | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private lastCompleted: { intent: string; title: string } | null = null
  /**
   * What fastASL typed last, for spacing what it types next. It outlives the dictation card
   * (Settings, a collapse, Spell mode and back), since none of those moves the cursor.
   */
  private lastTyped: { kind: Token['kind']; at: number } | null = null
  /** An Insert text / spelling paste is on its way: a second pick would type it twice. */
  private inserting = false
  /** A stream picked in Settings that hasn't shown a frame yet (cameraStatus). */
  private untestedStream = false
  private unsubscribe: (() => void) | null = null
  /**
   * The notice a running LLM call put up ("Rate limited, retrying..."), and whether that call is
   * still the card's. It goes when the call settles or is superseded or cancelled.
   */
  private llmStatus: { text: string; current: () => boolean } | null = null
  /** The last LLM error shown as the notice: a later call's status may take its place. */
  private llmErrorNotice: string | null = null
  /**
   * LLM calls in flight, each with whether it is still the card's. One that stops being the
   * card's is aborted, in main too, so a rate-limited call doesn't keep retrying for nobody.
   */
  private llmCalls = new Map<AbortController, () => boolean>()
  /** Bumped whenever the phrase changes (a sign added or deleted, an edit, a reset): a guess started before is superseded. */
  private phraseVersion = 0
  /** The identifySign call in flight: at most one. */
  private signGuess: AbortController | null = null
  private lastGuessAt = -Infinity
  private lastGuessErrorAt = -Infinity
  /** "Is this HELLO?" on screen: the list, the movement a pick learns, and where the card goes back to. */
  private learning: { list: View; features: number[][]; hands: Map<string, 1 | 2>; back: View } | null = null
  /** Teach › Show me a sign: the movement its guesses are for. */
  private shown: { guess: View; features: number[][]; hands: Map<string, 1 | 2> } | null = null

  constructor(private services: Services) {
    this.subscribe()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.clearTimers()
    // A guess still running would otherwise land on whatever card comes next.
    this.signGuess?.abort()
    this.signGuess = null
  }

  /** Swap service implementations (mock <-> real) at runtime. */
  setServices(services: Services): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.services = services
    this.subscribe()
  }

  private subscribe(): void {
    if (!this.unsubscribe) this.unsubscribe = this.services.onAgentEvent((e) => this.onAgentEvent(e))
  }

  get view(): View {
    return getApp().view
  }

  // ---------------------------------------------------------------- helpers

  setView(view: View): void {
    this.clearTimers()
    setApp({ view, pick: null, signing: false })
    this.dropStaleLlmCalls()
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
  }

  private clearTimers(): void {
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
  }

  notify(notice: string | null, ms = 5000): void {
    setApp({ notice })
    if (notice) {
      setTimeout(() => {
        if (getApp().notice === notice) setApp({ notice: null })
      }, ms)
    }
  }

  /**
   * Shows a running LLM call's status as the notice, unless the call is stale or another notice
   * is up. An earlier LLM error ("Gemini is rate limited...") is not another notice: it gives way.
   */
  private showLlmStatus(current: () => boolean, text: string): void {
    if (!current()) return
    const { notice } = getApp()
    if (notice !== null && notice !== this.llmStatus?.text && notice !== this.llmErrorNotice) return
    this.llmStatus = { text, current }
    setApp({ notice: text })
  }

  /** Whether the status notice of the call `current` belongs to is on screen. */
  private showsLlmStatus(current: () => boolean): boolean {
    return this.llmStatus?.current === current && getApp().notice === this.llmStatus.text
  }

  /** An LLM call's error as the notice, for the usual 5 s. */
  private notifyLlmError(text: string): void {
    this.llmErrorNotice = text
    this.notify(text)
  }

  /** Takes down the status notice of the call `current` belongs to (of any call, without it). */
  private clearLlmStatus(current?: () => boolean): void {
    const status = this.llmStatus
    if (!status || (current && status.current !== current)) return
    this.llmStatus = null
    if (getApp().notice === status.text) setApp({ notice: null })
  }

  /** A superseded or cancelled call is aborted, and its status notice goes with it. */
  private dropStaleLlmCalls(): void {
    for (const [abort, current] of this.llmCalls) {
      if (current()) continue
      this.llmCalls.delete(abort)
      abort.abort()
    }
    if (this.llmStatus && !this.llmStatus.current()) this.clearLlmStatus()
  }

  /** The pending interpretation is out of date (edited, re-signed, cancelled). */
  private forgetInterpretation(): void {
    this.interpretation = null
    this.dropStaleLlmCalls()
  }

  private idleView(): View {
    if (getApp().mode === 'dictation') return { kind: 'dictation', text: '' }
    // A quick-menu pick keeps waiting for its details, also after a movement that was no sign.
    if (this.intentPrefix) return { kind: 'ready', hint: `${this.intentPrefix}: sign the details` }
    return this.signingTask ? { kind: 'ready', hint: SIGN_TASK_HINT } : { kind: 'ready' }
  }

  /** The signed words go, the context they were signed for (quick-menu prefix, a gesture's task) stays. */
  private startNextPhrase(): void {
    this.phraseVersion++
    this.tokens = []
    this.forgetInterpretation()
  }

  private resetPhrase(): void {
    this.phraseVersion++
    this.tokens = []
    this.forgetInterpretation()
    this.intentPrefix = undefined
    this.signingTask = false
  }

  // ---------------------------------------------------------------- entry points

  expand(): void {
    this.resetPhrase()
    this.setView(this.idleView())
  }

  collapse(): void {
    this.resetPhrase()
    this.setView({ kind: 'collapsed' })
  }

  toggleCamera(): void {
    const cameraOn = !getApp().cameraOn
    setApp({ cameraOn })
    void window.fastasl?.saveSettings({ cameraEnabled: cameraOn })
  }

  /**
   * Settings › Camera source: applied at once (engines.ts switches the running camera when
   * the store changes), and a camera that was off is turned back on. The MacBook camera is
   * saved at once, a stream only once it shows a frame (cameraStatus).
   */
  private switchCamera(cameraSource: CameraSource, streamUrl?: string): void {
    const before = getApp().cameraSource
    const showing = !live.mock && before.kind === 'mjpeg' && cameraSource.kind === 'mjpeg' && before.url === cameraSource.url
    this.untestedStream = cameraSource.kind === 'mjpeg' && !showing
    const url = streamUrl === undefined ? {} : { streamUrl }
    const source = this.untestedStream ? {} : { cameraSource }
    setApp({ cameraSource, cameraOn: true, ...url })
    void window.fastasl?.saveSettings({ ...source, cameraEnabled: true, ...url })
  }

  /**
   * engines.ts: the camera's first frame (null) or why it failed. Hand gestures need camera
   * frames, so a stream picked in Settings that fails before its first one gives way to the
   * MacBook camera: a wrong URL or an ESP32 that is off never takes hand control away.
   */
  cameraStatus(error: string | null): void {
    if (!this.untestedStream) return
    this.untestedStream = false
    if (!error) return void window.fastasl?.saveSettings({ cameraSource: getApp().cameraSource })
    setApp({ cameraSource: BUILTIN_CAMERA })
    void window.fastasl?.saveSettings({ cameraSource: BUILTIN_CAMERA })
    this.notify(cameraFallbackNotice(error), CAMERA_FALLBACK_NOTICE_MS)
    const view = this.view
    if (view.kind === 'settings' && view.settings.page === 'camera') {
      this.setView({ kind: 'settings', settings: { ...view.settings, current: 'builtin' } })
    }
  }

  cycleMode(dir: 1 | -1): void {
    const { mode } = getApp()
    this.switchMode(MODES[(MODES.indexOf(mode) + dir + MODES.length) % MODES.length])
  }

  /** Swipes and the dictation fist: the header flashes the new mode, which is saved for the next launch. */
  private switchMode(mode: Mode): void {
    setApp({ mode, modeFlashAt: performance.now() })
    void window.fastasl?.saveSettings({ mode })
    this.resetPhrase()
    this.setView(this.idleView())
  }

  /** Launch: the saved camera, sensitivity and mode take effect before the camera and engines start. */
  async loadSettings(): Promise<void> {
    const s = await window.fastasl?.getSettings().catch(() => null)
    if (!s) return
    setApp({ cameraOn: s.cameraEnabled, cameraSource: s.cameraSource, streamUrl: s.streamUrl, sensitivity: s.sensitivity })
    this.restoreMode(s.mode)
  }

  /** The mode saved last time, applied at launch: an idle card shows that mode's idle view. */
  restoreMode(mode: Mode): void {
    setApp({ mode })
    const kind = this.view.kind
    if (kind === 'ready' || kind === 'dictation') this.setView(this.idleView())
  }

  openSettings(): void {
    // Settings leads back to a fresh Ready, where a phrase left behind would resurface.
    this.resetPhrase()
    this.setView({ kind: 'settings', settings: { page: 'root' } })
  }

  /** Gesture from the engine or a dev hotkey. Gated by the current view. */
  gesture(input: GestureInput): void {
    const view = this.view
    if (!activeGestures(view, getApp().mode).has(input.gesture)) return
    const g = input.gesture
    switch (view.kind) {
      case 'collapsed':
        if (g === 'palmHold') this.expand()
        else if (g === 'shape' && input.shapeId) void this.runShortcut(input.shapeId, 'collapsed')
        return
      case 'ready':
        return this.readyGesture(input)
      case 'recognizing':
      case 'building':
        if (isListening(view)) return this.readyGesture(input)
        if (g === 'thumbsUp' || g === 'swipeRight' || g === 'handsDown') this.endPhrase()
        else if (g === 'swipeLeft') this.deleteLastToken()
        else if (g === 'fist') this.cancel()
        return
      case 'sentence':
        if (g === 'swipeLeft') this.deleteLastToken()
        else if (g === 'swipeRight' || g === 'thumbsUp') void this.proceed()
        else if (g === 'fist') this.cancel()
        return
      case 'agentReady':
        if (g === 'thumbsUp') void this.runAgent(view.intent, view.sentence)
        else if (g === 'fist') this.cancel()
        else if (g === 'swipeLeft') this.change()
        return
      case 'working':
        if (g === 'fist') this.stopAgent()
        return
      case 'confirm':
        if (g === 'thumbsUp') void this.respondConfirm(true)
        else if (g === 'fist') void this.respondConfirm(false)
        return
      case 'didYouMean':
        if (g === 'fingers' && input.count) this.pickOption(input.count - 1)
        else if (g === 'thumbsUp') this.pickOption(0)
        else if (g === 'swipeLeft') this.change()
        else if (g === 'fist') return view.purpose === 'learn' ? this.declineGuess() : this.cancel()
        return
      case 'done':
        if (g === 'thumbsUp') this.expand()
        else if (g === 'fingers' && input.count) this.pickOption(input.count - 1)
        else if (g === 'swipeUp') this.openSettings()
        else if (g === 'fist') this.collapse()
        return
      case 'contextActions':
      case 'quickMenu':
        if (g === 'fingers' && input.count) this.pickOption(input.count - 1)
        else if (g === 'fist') this.cancel()
        return
      case 'dictation':
        if (g === 'swipeLeft') this.cycleMode(-1)
        else if (g === 'swipeRight') this.cycleMode(1)
        else if (g === 'swipeUp') this.openSettings()
        else if (g === 'fist') this.switchMode('command')
        return
      case 'toast':
        if (g === 'fist') this.leaveToast(view.returnTo)
        return
      case 'settings': {
        const page = view.settings
        if (g === 'fingers' && input.count) this.pickOption(input.count - 1)
        else if (g === 'fist') this.settingsBack()
        else if (page.page === 'teachPick' && (g === 'swipeLeft' || g === 'swipeRight')) this.teachPage(g === 'swipeRight' ? 1 : -1)
        else if (page.page === 'teachSpell' && g === 'swipeLeft') this.deleteTeachLetter(page.letters)
        else if (page.page === 'teachSpell' && g === 'thumbsUp') this.confirmTeachWord()
        else if (page.page === 'teachRecord' && g === 'swipeLeft') this.settingsBack()
        else if (page.page === 'teachShow' && g === 'thumbsUp') this.pickOption(0)
        else if (page.page === 'gestures' && (g === 'swipeLeft' || g === 'swipeRight')) this.gesturePage(page, g === 'swipeRight' ? 1 : -1)
        else if (page.page === 'newGestureHold' && g === 'swipeLeft') this.settingsBack()
        else if (page.page === 'newGestureHold' && g === 'thumbsUp') this.startShapeCapture(page.task)
        else if (page.page === 'camera' && page.editing && g === 'swipeLeft') this.settingsBack()
        return
      }
    }
  }

  private readyGesture(input: GestureInput): void {
    const g = input.gesture
    if (g === 'thumbsUp') this.setView({ kind: 'quickMenu', options: QUICK_MENU })
    else if (g === 'fist') this.collapse()
    else if (g === 'swipeLeft') this.cycleMode(-1)
    else if (g === 'swipeRight') this.cycleMode(1)
    else if (g === 'swipeUp') this.openSettings()
    else if (g === 'shape' && input.shapeId) void this.runShortcut(input.shapeId, 'ready')
  }

  /** Mouse taps. */
  tap(target: TapTarget, index?: number): void {
    const view = this.view
    if (target === 'collapse') return this.collapse()
    if (target === 'expand') return this.expand()
    if (target === 'camera') return this.toggleCamera()
    if (target === 'settings') return this.openSettings()
    if (target === 'option' && index !== undefined) return this.pickOption(index)
    if (target === 'close') {
      if (view.kind === 'working') this.stopAgent()
      else if (view.kind === 'confirm') void this.respondConfirm(false)
      else if (view.kind === 'settings') this.settingsBack()
      else if (view.kind === 'toast') this.leaveToast(view.returnTo)
      else if (view.kind === 'didYouMean' && view.purpose === 'learn') this.declineGuess()
      else {
        // The X on the dictation card starts a new run of text: no space before the next sign.
        if (view.kind === 'dictation') this.lastTyped = null
        this.cancel()
      }
      return
    }
    if (target === 'proceed') {
      if (view.kind === 'building' || view.kind === 'recognizing') this.endPhrase()
      else if (view.kind === 'sentence') void this.proceed()
      return
    }
    // primary / secondary
    switch (view.kind) {
      case 'agentReady':
        if (target === 'primary') void this.runAgent(view.intent, view.sentence)
        else this.change()
        return
      case 'confirm':
        void this.respondConfirm(target === 'primary')
        return
      case 'didYouMean':
        if (target === 'primary') this.pickOption(0)
        else this.change()
        return
      case 'done':
        if (target === 'primary') this.expand()
        else if (view.view) void this.services.openTarget(view.view)
        return
      case 'sentence':
        if (target === 'primary') void this.proceed()
        else this.cancel()
        return
      case 'toast':
        if (target === 'secondary') this.leaveToast(view.returnTo)
        return
      default:
        if (target === 'secondary') this.cancel()
    }
  }

  // ---------------------------------------------------------------- recognition input

  /**
   * A movement has lasted long enough to be signing (recognitionInput debounces it): show
   * "Listening...".
   */
  signStart(): void {
    // The header says "Listening..."; the card itself stays until a sign is recognized.
    if (takesSigns(this.view)) setApp({ signing: true })
  }

  /** The movement after signStart was not a known sign, or was dropped: stop listening. */
  signRejected(): void {
    setApp({ signing: false })
    // The Listening card (no word yet: the last one was deleted) goes back to the idle card.
    if (isListening(this.view)) this.setView(this.idleView())
  }

  /** A sign / letter was recognized. */
  token(token: Token): void {
    const view = this.view
    const mode = getApp().mode
    if (view.kind === 'settings') {
      // Teach a sign › Spell a new word.
      if (view.settings.page === 'teachSpell' && token.kind === 'letter') this.setTeachWord(view.settings.letters + token.text)
      return
    }
    if (mode === 'dictation' && (view.kind === 'dictation' || view.kind === 'ready')) {
      this.phraseVersion++
      return this.dictate(token, view.kind === 'dictation' ? view.text : '')
    }
    if (view.kind === 'didYouMean' && view.purpose === 'sign') return
    if (!['ready', 'recognizing', 'building', 'sentence'].includes(view.kind)) return
    // A sign after a finished sentence starts the next phrase: the card moves on.
    if (view.kind === 'sentence') this.startNextPhrase()
    this.phraseVersion++
    this.tokens.push(token)
    this.forgetInterpretation()
    if (this.tokens.length === 1) {
      this.setView({ kind: 'recognizing', token: token.text, isWord: token.kind === 'word' })
      return
    }
    this.setView({
      kind: 'building',
      tokens: [...this.tokens],
      current: token.text,
      sentence: assembleSentence(this.tokens)
    })
  }

  /** Whether new text continues what fastASL typed last (and so needs a space before it). */
  private continuesRun(): boolean {
    return this.lastTyped !== null && Date.now() - this.lastTyped.at < TYPED_RUN_MS
  }

  /**
   * Dictation types each sign at the cursor of the focused app as it is recognized. Letters
   * join only on the card that typed them; an empty card continues a recent run as a new word.
   */
  private dictate(token: Token, cardText: string): void {
    const previous = cardText ? (this.lastTyped?.kind ?? 'word') : this.continuesRun() ? 'word' : null
    const chunk = dictationChunk(previous, token)
    this.lastTyped = { kind: token.kind, at: Date.now() }
    this.setView({ kind: 'dictation', text: (cardText + chunk).slice(-DICTATION_KEEP) })
    void settled(this.services.typeText(chunk)).then((res) => {
      if (!res.ok) this.notify(failureText(res), TYPING_NOTICE_MS)
    })
  }

  /** Recognition was unsure between several signs: ask the user while a phrase is being signed. */
  ambiguousSign(options: string[]): void {
    // Dictation types as you sign: a question per word would stall it, so it takes the best guess.
    if (getApp().mode === 'dictation') return this.token({ text: options[0], kind: 'word' })
    if (!['ready', 'recognizing', 'building', 'sentence'].includes(this.view.kind)) return
    // The phrase grows (or is edited): an interpretation of the Sentence card is out of date.
    this.forgetInterpretation()
    this.setView({ kind: 'didYouMean', variant: 'list', options: options.slice(0, 3), purpose: 'sign' })
  }

  // ---------------------------------------------------------------- guess, confirm, learn

  /**
   * Whether a movement no taught word matched may go to the LLM now: an LLM is available, no
   * guess is in flight, the last one started SIGN_GUESS_COOLDOWN_MS ago or more, and the card is
   * where a sign lands (not Spell mode). Recognition asks before it builds the request.
   */
  guessesSigns(): boolean {
    if (this.services.signGuessUnavailable() !== null || this.signGuess) return false
    if (Date.now() - this.lastGuessAt < SIGN_GUESS_COOLDOWN_MS) return false
    return getApp().mode !== 'spell' && guessView(this.view)
  }

  /**
   * Whether the camera's recent frames should be kept for a guess: a provider that looks at
   * them, and a card where a guess can start. Elsewhere none are captured.
   */
  wantsSignFrames(): boolean {
    if (this.services.signGuessUnavailable() !== null || !this.services.sendsFrames()) return false
    if (showsSign(this.view)) return true
    return getApp().mode !== 'spell' && guessView(this.view)
  }

  /**
   * Recognition: a whole, clean movement of sign length that no taught word matched, already
   * rejected as any such movement (Listening ended), and no control gesture or letter followed
   * it. The card carries on, with "Identifying sign..." while the LLM looks at it; "Is this X?"
   * follows if it names a sign. A sign recognized meanwhile, an edit, a mode switch or a screen
   * where signs don't land supersedes the guess, which is then cancelled.
   */
  unknownSign(movement: UnknownMovement): void {
    if (!this.guessesSigns()) return
    const version = this.phraseVersion
    const abort = new AbortController()
    const current = (): boolean => this.signGuess === abort && this.phraseVersion === version && guessView(this.view)
    this.signGuess = abort
    this.lastGuessAt = Date.now()
    this.llmCalls.set(abort, current)
    this.showLlmStatus(current, IDENTIFYING)
    void this.guessSign(movement, current, abort)
  }

  private async guessSign(movement: UnknownMovement, current: () => boolean, abort: AbortController): Promise<void> {
    const res = await this.identify(movement, current, abort)
    const still = current()
    if (this.signGuess === abort) this.signGuess = null
    if (!still) return // superseded or cancelled: nothing is learned
    if (!res.ok) return this.guessFailed(res.error)
    if (!res.value.length) return // not a sign: carry on, as for any movement nothing matched
    const view = this.view
    const list: View = { kind: 'didYouMean', variant: 'list', options: res.value, purpose: 'learn' }
    this.learning = { list, features: movement.features, hands: res.hands, back: isListening(view) ? this.idleView() : view }
    this.setView(list)
  }

  /** One identifySign call: its status lines as the notice while it is the card's, its glosses (none when it's no sign). */
  private async identify(
    movement: UnknownMovement,
    current: () => boolean,
    abort: AbortController
  ): Promise<{ ok: true; value: string[]; hands: Map<string, 1 | 2> } | { ok: false; error: string }> {
    const { mode, templates } = getApp()
    const req: IdentifySignRequest = {
      frames: movement.frames,
      motion: movement.motion,
      // Show me a sign (Settings) may be opened from Spell mode; a sign is a word either way.
      mode: mode === 'spell' ? 'command' : mode,
      known: taughtWords(templates)
    }
    let call: Promise<Result<SignGuess>>
    try {
      call = this.services.identifySign(req, (status) => this.showLlmStatus(current, status), abort.signal)
    } catch (err) {
      // A bridge that throws instead of answering (an old preload) is a failed guess, never a stuck one.
      call = Promise.resolve({ ok: false, error: errorText(err) })
    }
    const res = await settled(call)
    this.llmCalls.delete(abort)
    this.clearLlmStatus(current)
    if (!res.ok) return { ok: false, error: failureText(res) }
    const picked = res.value.is_sign ? res.value.candidates.filter((c) => c.gloss).slice(0, 3) : []
    return { ok: true, value: picked.map((c) => c.gloss), hands: new Map(picked.map((c) => [c.gloss, c.hands])) }
  }

  /** A failed guess (no key, a rate limit, no network): the movement stays rejected, and why is said at most once a minute. */
  private guessFailed(error: string): void {
    if (error === 'Cancelled') return
    const now = Date.now()
    if (now - this.lastGuessErrorAt < SIGN_GUESS_ERROR_EVERY_MS) return
    this.lastGuessErrorAt = now
    this.notifyLlmError(error)
  }

  /** "Is this X?" picked: the word joins the phrase as a recognized sign would, and that movement is learned as it. */
  private confirmGuess(gloss: string): void {
    const learning = this.learning
    this.learning = null
    if (!learning || this.view !== learning.list) return
    this.setView(learning.back)
    // On the Sentence card (the phrase ended meanwhile) the word starts the next phrase, like any sign there.
    this.token({ text: gloss.toLowerCase(), kind: 'word' })
    void this.learnSign(gloss, learning.features, learning.hands.get(gloss))
  }

  /** Fist (or X) on "Is this X?": nothing is learned and the card goes back to the phrase. */
  private declineGuess(): void {
    const back = this.learning?.back ?? this.idleView()
    this.learning = null
    this.setView(back)
  }

  /**
   * Saves the confirmed movement as one more template of `label` (a new word, or another
   * example of one already taught), so recognition knows it next time. A notice says so: a
   * toast would interrupt the phrase.
   */
  private async learnSign(label: string, features: number[][], hands?: 1 | 2): Promise<void> {
    const error = await this.addTemplates([wordTemplate(label, learnedFrames(features, hands))])
    this.notify(error ? `Couldn't save ${label}: ${error}` : `Learned ${label}`)
  }

  /** Both hands down / stillness ended the phrase. */
  phraseEnd(): void {
    const kind = this.view.kind
    if (kind === 'recognizing' || kind === 'building') this.endPhrase()
  }

  // ---------------------------------------------------------------- phrase flow

  private cancel(): void {
    this.resetPhrase()
    this.setView(this.idleView())
  }

  private deleteLastToken(): void {
    if (!this.tokens.length) return this.cancel()
    // Delete a whole word: trailing run of letters counts as one word. Spell mode spells one
    // word, so there a swipe takes back a letter.
    const last = this.tokens[this.tokens.length - 1]
    if (last.kind === 'letter' && getApp().mode !== 'spell') {
      while (this.tokens.length && this.tokens[this.tokens.length - 1].kind === 'letter') this.tokens.pop()
    } else {
      this.tokens.pop()
    }
    this.phraseVersion++
    this.forgetInterpretation()
    if (!this.tokens.length) return this.cancel()
    if (this.view.kind === 'sentence') {
      this.setView({ kind: 'sentence', sentence: assembleSentence(this.tokens), tokens: [...this.tokens] })
      this.prefetchInterpretation()
    } else {
      this.resumeBuilding()
    }
  }

  /** Back to the token strip with the phrase so far (or to listening when it is empty). */
  private resumeBuilding(): void {
    if (!this.tokens.length) return this.setView({ kind: 'recognizing', token: null, isWord: false })
    this.setView({ kind: 'building', tokens: [...this.tokens], current: null, sentence: assembleSentence(this.tokens) })
  }

  private endPhrase(): void {
    if (!this.tokens.length) return this.cancel()
    if (getApp().mode === 'spell') return void this.spellSuggestions()
    this.setView({ kind: 'sentence', sentence: assembleSentence(this.tokens), tokens: [...this.tokens] })
    this.prefetchInterpretation()
  }

  /** Start Claude early so "proceed" feels instant. */
  private prefetchInterpretation(): Promise<Interpretation> {
    const tokens = this.tokens.map((t) => t.text)
    const sentence = assembleSentence(this.tokens)
    const intentPrefix = this.intentPrefix
    const mode = getApp().mode
    const current = (): boolean => this.interpretation === interpretation
    const abort = new AbortController()
    const interpretation = (async (): Promise<Interpretation> => {
      const frontmost = await this.services.frontmostApp().catch(() => null)
      const gestures = (await window.fastasl?.getGestures().catch(() => [])) ?? []
      const res = await settled(
        this.services.interpret(
          {
            tokens,
            sentence,
            mode,
            intentPrefix,
            frontmost,
            gestures: gestures.map((g) => ({ name: g.name, task: g.task }))
          },
          (status) => this.showLlmStatus(current, status),
          abort.signal
        )
      )
      this.llmCalls.delete(abort)
      const retrying = this.showsLlmStatus(current)
      this.clearLlmStatus(current)
      if (res.ok) return { result: res.value, error: null }
      const error = failureText(res)
      // The card said it was retrying: when that fails, it says so now, not only on proceed.
      if (retrying && current()) this.notifyLlmError(error)
      return { result: null, error }
    })()
    this.interpretation = interpretation
    this.llmCalls.set(abort, current)
    this.dropStaleLlmCalls()
    return interpretation
  }

  private async proceed(): Promise<void> {
    const view = this.view
    if (view.kind !== 'sentence') return
    const pending = this.interpretation ?? this.prefetchInterpretation()
    const thinking: View = { ...view, thinking: true }
    this.setView(thinking)
    const { result, error } = await pending
    // Edited, re-signed or cancelled meanwhile: this answer is for an old sentence.
    if (this.view !== thinking) return
    const sentence = view.sentence
    if (this.signingTask) return this.taskSigned(result, error, sentence)
    if (!result) {
      // Claude unavailable: still let the agent try with the raw sentence and the quick-menu pick.
      if (error) this.notifyLlmError(error)
      const intent = this.intentPrefix ? `${this.intentPrefix}: ${sentence}` : sentence
      this.setView({ kind: 'agentReady', intent, variant: 'default', sentence })
      return
    }
    this.routeIntent(result, sentence)
  }

  /** New gesture › Sign a new task: Claude's intent (else the sentence) is the task; then the shape. */
  private taskSigned(result: IntentResult | null, error: string | null, rawSentence: string): void {
    if (error) this.notifyLlmError(error)
    const sentence = result?.sentence || rawSentence
    const task = result?.intent || (this.intentPrefix ? `${this.intentPrefix}: ${sentence}` : sentence)
    this.resetPhrase()
    this.startShapeCapture(task)
  }

  private routeIntent(result: IntentResult, rawSentence: string): void {
    const sentence = result.sentence || rawSentence
    const { intent } = result
    const alternatives = result.alternatives.filter((a) => a && a !== intent)
    const guessing = result.confidence < LOW_CONFIDENCE && (intent !== null || alternatives.length > 0)
    const closeCall = intent !== null && alternatives.length > 0 && result.confidence < CLOSE_CALL
    if (guessing || closeCall) {
      // Numbered, so whatever will run is on screen: the intent first, then the alternatives.
      // Without an intent the sentence may be text to type, so Insert text is offered too.
      const options = intent ? [intent, ...alternatives].slice(0, 3) : [...alternatives.slice(0, 3), INSERT_TEXT]
      this.setView({ kind: 'didYouMean', variant: 'list', options, purpose: 'intent', quote: sentence })
      return
    }
    if (!intent) {
      this.setView({ kind: 'contextActions', sentence, actions: contextActionsFor(result.context_actions) })
      return
    }
    const email = intent.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)
    this.setView({
      kind: 'agentReady',
      intent,
      variant: email ? 'email' : 'default',
      target: email?.[0],
      sentence
    })
  }

  private change(): void {
    const view = this.view
    if (view.kind === 'didYouMean' && view.purpose === 'learn') return this.declineGuess()
    // "Edit" on a spelling or sign list goes back to signing, not to the agent sentence.
    if (view.kind === 'didYouMean' && view.purpose !== 'intent') return this.resumeBuilding()
    const sentence = assembleSentence(this.tokens)
    if (!sentence) return this.cancel()
    this.setView({ kind: 'sentence', sentence, tokens: [...this.tokens] })
    this.prefetchInterpretation()
  }

  /** Inline keyboard edit of the sentence (pencil icon). */
  editSentence(text: string): void {
    const words = text.trim().split(/\s+/).filter(Boolean)
    this.phraseVersion++
    this.tokens = words.map((w) => ({ text: w, kind: 'word' as const }))
    if (!this.tokens.length) return this.cancel()
    this.setView({ kind: 'sentence', sentence: text.trim(), tokens: [...this.tokens] })
    this.prefetchInterpretation()
  }

  private pickOption(index: number): void {
    const view = this.view
    const options = optionsFor(view)
    if (index < 0 || index >= options.length) return
    const choice = options[index]
    switch (view.kind) {
      case 'didYouMean':
        if (view.purpose === 'learn') {
          this.confirmGuess(choice)
        } else if (view.purpose === 'sign') {
          this.phraseVersion++
          this.tokens.push({ text: choice, kind: 'word' })
          this.forgetInterpretation()
          this.setView({
            kind: 'building',
            tokens: [...this.tokens],
            current: choice,
            sentence: assembleSentence(this.tokens)
          })
        } else if (view.purpose === 'spell') {
          // Spellings still on their way would bring back the list being picked from.
          if (view.pending && !this.inserting) this.setView({ ...view, pending: false })
          void this.insert(choice, 'Typed')
        } else if (choice === INSERT_TEXT) {
          void this.contextAction(choice, view.quote ?? assembleSentence(this.tokens))
        } else {
          // Either variant: Agent ready shows the intent before anything runs.
          this.setView({ kind: 'agentReady', intent: choice, variant: 'default', sentence: view.quote ?? choice })
        }
        return
      case 'contextActions':
        void this.contextAction(choice, view.sentence)
        return
      case 'quickMenu':
        this.intentPrefix = choice
        // From Context actions › More options: the signed sentence is the details, so interpret it now.
        if (view.fromSentence) {
          this.forgetInterpretation()
          this.setView({ kind: 'sentence', sentence: assembleSentence(this.tokens), tokens: [...this.tokens] })
          void this.proceed()
          return
        }
        this.setView(this.idleView())
        return
      case 'done':
        if (index === 0 && view.view) void this.services.openTarget(view.view)
        else if (index === 1) this.expand()
        else if (index === 2) this.startNewGesture(view.intent)
        return
      case 'settings':
        this.settingsPick(view.settings, index)
        return
    }
  }

  private async contextAction(action: string, sentence: string): Promise<void> {
    if (isInsertAction(action)) return this.insert(sentence, 'Text inserted')
    if (isMoreAction(action)) {
      this.setView({ kind: 'quickMenu', options: QUICK_MENU, fromSentence: true })
      return
    }
    this.setView({ kind: 'agentReady', intent: `${action}: "${sentence}"`, variant: 'default', sentence })
  }

  /** The raw letters can be picked at once; Claude's spellings join them when they arrive. */
  private async spellSuggestions(): Promise<void> {
    const letters = this.tokens.map((t) => t.text).join('')
    const list: View = { kind: 'didYouMean', variant: 'list', options: [letters], purpose: 'spell', quote: letters }
    const pending: View = { ...list, pending: true }
    this.setView(pending)
    const current = (): boolean => this.view === pending
    const abort = new AbortController()
    this.llmCalls.set(abort, current)
    const frontmost = await this.services.frontmostApp().catch(() => null)
    const res = await settled(
      this.services.spellSuggest({ letters, frontmost }, (status) => this.showLlmStatus(current, status), abort.signal)
    )
    this.llmCalls.delete(abort)
    this.clearLlmStatus(current)
    if (!current()) return // picked, edited or cancelled meanwhile
    if (!res.ok) this.notifyLlmError(failureText(res))
    const options = res.ok ? [letters, ...res.value.filter((s) => s !== letters)].slice(0, 3) : [letters]
    this.setView({ ...list, options })
  }

  /**
   * Types into the focused app (spaced from text typed just before), then toasts. A failure (no
   * Accessibility, say) keeps the card where it was, with the reason, so the pick can be made
   * again once it is fixed. The first paste can wait long on a permission prompt: a card that
   * moved on meanwhile only gets a notice, so a phrase started since is kept.
   */
  private async insert(text: string, title: string): Promise<void> {
    if (this.inserting) return this.notify('Still typing the last pick')
    this.inserting = true
    const from = this.view
    const res = await settled(this.services.typeText(this.continuesRun() ? ` ${text}` : text))
    this.inserting = false
    if (!res.ok) return this.notify(failureText(res), TYPING_NOTICE_MS)
    this.lastTyped = { kind: 'word', at: Date.now() }
    if (this.view === from) this.toast(title, text, true)
    else this.notify(`${title}: “${text}”`)
  }

  // ---------------------------------------------------------------- agent

  async runAgent(intent: string, sentence: string): Promise<void> {
    this.subscribe() // dispose() may have run (React StrictMode re-mounts App)
    // The run uses up the phrase, however it ends: Done, Settings and Ready start a new one.
    this.resetPhrase()
    // The agent may switch apps or type itself: what fastASL types next starts a new run.
    this.lastTyped = null
    this.steps = []
    // One run at a time: the main process stops whatever ran before, a pending shortcut included.
    this.shortcut = null
    const run: AgentRunState = { runId: null, intent, shortcut: false, held: [] }
    this.agentRun = run
    this.setView({ kind: 'working', intent, steps: [] })
    const frontmost = await this.services.frontmostApp().catch(() => null)
    if (this.agentRun !== run) return // stopped before the agent started
    const res = await settled(this.services.agentRun({ intent, sentence, frontmost }))
    if (this.agentRun !== run) return // stopped meanwhile (clearRun released what it held)
    if (!res.ok) {
      this.clearRun()
      this.setView({ kind: 'done', ok: false, title: "Couldn't start the agent", subtitle: failureText(res), intent })
      this.later(DONE_AUTO_COLLAPSE_MS * 2, () => this.collapse())
      return
    }
    run.runId = res.value.runId
    // The held events can be told apart now: this run's are shown, the others dropped.
    for (const e of run.held.splice(0)) this.onAgentEvent(e)
  }

  /** Takes the run off the card. Events held for a run that was never named are then another run's. */
  private clearRun(): void {
    const held = this.agentRun?.held ?? []
    this.agentRun = null
    for (const e of held) this.onAgentEvent(e)
  }

  /** Fist or X while working: the card leaves at once; the main process interrupts the run. */
  private stopAgent(): void {
    const runId = this.agentRun?.runId ?? null
    this.shortcut = null
    this.clearRun()
    this.agentStopped(runId)
    void this.services.agentStop().catch(() => undefined)
  }

  private agentStopped(runId: string | null): void {
    this.toast('Stopped', 'The agent was interrupted', false)
    this.stopped = runId ? { runId, toast: this.view } : null
  }

  /**
   * Main reports a stopped run only when a write had already gone through (a sent message, say,
   * possibly finishing after the stop). The card says so, or the user might send it again.
   */
  private reportStopped(result: AgentResult): void {
    const toast = this.stopped?.toast
    this.stopped = null
    if (this.view === toast) this.toast(result.title, result.subtitle, false)
    else this.notify(`${result.title} before you stopped`)
  }

  private async respondConfirm(approved: boolean): Promise<void> {
    const view = this.view
    if (view.kind !== 'confirm') return
    this.setView({ kind: 'working', intent: this.agentRun?.intent ?? '', steps: [...this.steps] })
    await this.services.agentRespond(view.requestId, approved)
  }

  /**
   * Every run opens with 'started'. A pending shortcut takes its runs on the card this way
   * (a replay that needs a confirm, then maybe the agent fallback).
   */
  private adopt(e: Extract<AgentEvent, { type: 'started' }>): void {
    if (!this.shortcut || (this.agentRun && !this.agentRun.shortcut)) return
    this.agentRun = { runId: e.runId, intent: e.intent, shortcut: true, held: [] }
    this.setView({ kind: 'working', intent: e.intent, steps: [] })
  }

  private onAgentEvent(e: AgentEvent): void {
    if (e.type === 'started') this.adopt(e)
    if (this.agentRun?.runId === null) {
      this.agentRun.held.push(e) // until agentRun's reply names the command's run
      return
    }
    if (e.type === 'done' && e.runId === this.stopped?.runId) return this.reportStopped(e.result)
    const run = this.agentRun?.runId === e.runId ? this.agentRun : null
    if (!run) {
      // Late event from a stopped, finished or replaced run. Never leave an agent waiting on an answer.
      if (e.type === 'confirm') void this.services.agentRespond(e.requestId, false)
      return
    }
    switch (e.type) {
      case 'started':
        this.steps = []
        return
      case 'step': {
        const i = this.steps.findIndex((s) => s.id === e.step.id)
        if (i >= 0) this.steps[i] = e.step
        else this.steps.push(e.step)
        const view = this.view
        if (view.kind === 'working') this.setView({ ...view, steps: [...this.steps] })
        return
      }
      case 'confirm':
        this.setView({ kind: 'confirm', requestId: e.requestId, details: e.details })
        return
      case 'done':
      case 'error':
      case 'stopped':
        this.agentRun = null
        // A shortcut's result is its toast (runShortcut), which says the same thing.
        if (run.shortcut) return
        if (e.type === 'stopped') return this.agentStopped(run.runId) // stopped by the main process, not the user
        if (e.type === 'error') {
          const subtitle = failureText({ error: e.message, missingKey: e.missingKey })
          this.setView({ kind: 'done', ok: false, title: "Couldn't finish", subtitle, intent: run.intent })
          this.later(DONE_AUTO_COLLAPSE_MS * 2, () => this.collapse())
          return
        }
        // Title and subtitle come from tool results; an unfinished task says why in the subtitle.
        if (e.complete) this.lastCompleted = { intent: run.intent, title: e.result.title }
        this.setView({
          kind: 'done',
          ok: e.complete,
          title: e.result.title,
          subtitle: e.result.subtitle,
          view: e.result.view,
          intent: run.intent
        })
        // Failures stay twice as long (matches the DoneView progress line).
        this.later(e.complete ? DONE_AUTO_COLLAPSE_MS : DONE_AUTO_COLLAPSE_MS * 2, () => this.collapse())
        return
    }
  }

  // ---------------------------------------------------------------- shortcuts & toasts

  toast(title: string, subtitle: string | undefined, ok: boolean, meta?: string): void {
    const returnTo = this.view.kind === 'collapsed' ? 'collapsed' : 'ready'
    this.showToast({ kind: 'toast', title, subtitle, ok, meta, returnTo })
  }

  async runShortcut(gestureId: string, returnTo: 'collapsed' | 'ready'): Promise<void> {
    this.subscribe() // its runs can show Working and Confirm
    // The main process stops any run on the card for the shortcut.
    this.clearRun()
    this.lastTyped = null // as for an agent run
    const pending = this.services.runShortcut(gestureId).catch(
      (err: unknown): ShortcutRunResult => ({
        ok: false,
        title: 'Shortcut failed',
        subtitle: errorText(err),
        compiled: false,
        durationMs: 0
      })
    )
    this.shortcut = pending
    const res = await pending
    if (this.shortcut !== pending) return // stopped, or replaced by a newer run
    this.shortcut = null
    const meta = res.ok && res.compiled ? `compiled · ${(res.durationMs / 1000).toFixed(1)} s` : undefined
    this.showToast({ kind: 'toast', title: res.title, subtitle: res.subtitle, ok: res.ok, meta, returnTo })
  }

  private showToast(toast: Extract<View, { kind: 'toast' }>): void {
    this.setView(toast)
    this.later(TOAST_MS, () => this.leaveToast(toast.returnTo))
  }

  /** A toast ends a flow: whatever phrase led to it is finished. */
  private leaveToast(returnTo: Extract<View, { kind: 'toast' }>['returnTo']): void {
    this.resetPhrase()
    if (typeof returnTo === 'object') return this.setView({ kind: 'settings', settings: returnTo })
    this.setView(returnTo === 'collapsed' ? { kind: 'collapsed' } : this.idleView())
  }

  // ---------------------------------------------------------------- settings

  private settingsBack(): void {
    const view = this.view
    if (view.kind !== 'settings') return
    const page = view.settings
    if (page.page === 'root') return this.setView(this.idleView())
    if (page.page === 'camera' && page.editing) return this.openCameraSettings() // closes the URL field
    if (page.page === 'gestureDetail') return void this.openGestureList(page.gesture.id)
    if (page.page === 'newGestureHold') return this.startNewGesture()
    if (page.page === 'teachRecord') return this.setView({ kind: 'settings', settings: this.teachList(page.label) })
    if (page.page === 'teachSpell' || page.page === 'teachShow') return this.setView({ kind: 'settings', settings: this.teachList() })
    this.openSettings()
  }

  private teachPage(dir: 1 | -1): void {
    const view = this.view
    if (view.kind !== 'settings' || view.settings.page !== 'teachPick') return
    const offset = Math.min(Math.max(0, view.settings.offset + dir * TEACH_PAGE), TEACH_LABELS.length - 1)
    this.setView({ kind: 'settings', settings: { ...view.settings, offset: offset - (offset % TEACH_PAGE) } })
  }

  /** The teach list on the page showing `label` (the first page for a spelled word), with fresh counts. */
  private teachList(label?: string): SettingsPage {
    const index = Math.max(0, label ? TEACH_LABELS.indexOf(label) : 0)
    return { page: 'teachPick', offset: index - (index % TEACH_PAGE), recorded: countSigns(getApp().templates) }
  }

  private teachRecordPage(): Extract<SettingsPage, { page: 'teachRecord' }> | null {
    const view = this.view
    return view.kind === 'settings' && view.settings.page === 'teachRecord' ? view.settings : null
  }

  /** Teach › Spell a new word: the word so far, fingerspelled or typed (letters, digits, spaces). */
  setTeachWord(text: string): void {
    const view = this.view
    if (view.kind !== 'settings' || view.settings.page !== 'teachSpell') return
    const letters = text
      .toUpperCase()
      .replace(/[^A-Z0-9 '-]/g, '')
      .replace(/\s+/g, ' ')
      .trimStart()
      .slice(0, MAX_TEACH_WORD)
    this.setView({ kind: 'settings', settings: { ...view.settings, letters } })
  }

  /**
   * Swipe left on Spell a new word deletes a letter, and past the start goes back to the list:
   * a fist can't always, since a taught S held there is a letter, not a fist.
   */
  private deleteTeachLetter(letters: string): void {
    if (letters) this.setTeachWord(letters.slice(0, -1))
    else this.settingsBack()
  }

  /** Thumbs up (or Return) on Spell a new word: record that word. */
  confirmTeachWord(): void {
    const view = this.view
    if (view.kind !== 'settings' || view.settings.page !== 'teachSpell') return
    const label = view.settings.letters.trim()
    if (!label) return this.notify('Spell or type the word first')
    this.setView({ kind: 'settings', settings: { page: 'teachRecord', label, kind: 'word', done: 0, total: TEACH_REPS.word } })
  }

  /** Teach › record: the recorder heard a movement start. */
  teachListening(): void {
    const page = this.teachRecordPage()
    if (page) this.setView({ kind: 'settings', settings: { ...page, listening: true } })
  }

  /**
   * Teach › record: a repetition was judged. `done` is shown as given: it can stay flat, or
   * drop when a better-agreeing group of repetitions takes over.
   */
  teachProgress(done: number, reason?: string): void {
    const page = this.teachRecordPage()
    if (page) this.setView({ kind: 'settings', settings: { ...page, done, listening: false, reason } })
  }

  /** Teach › record (or Show me a sign) finished: add the new templates to signs.json, then back to the teach list. */
  async teachLearned(label: string, learned: SignTemplate[]): Promise<void> {
    const view = this.view
    const error = await this.addTemplates(learned)
    if (this.view !== view) return // left the page meanwhile
    this.showToast({
      kind: 'toast',
      title: error ? `Couldn't save ${label}` : `Learned ${label}`,
      subtitle: error ?? (learned.length === 1 ? '1 recording saved' : `${learned.length} recordings saved`),
      ok: !error,
      returnTo: this.teachList(label)
    })
  }

  /** Adds templates to signs.json and the store (recognition follows the store). Returns why it failed, or null. */
  private async addTemplates(learned: SignTemplate[]): Promise<string | null> {
    try {
      // Merge with the file, not the store: a pack may have been imported meanwhile.
      const saved = await window.fastasl?.getTemplates()
      const templates = mergeTemplates(saved?.templates ?? getApp().templates, learned)
      await window.fastasl?.saveTemplates({ version: 1, templates })
      setApp({ templates })
      return null
    } catch (err) {
      return errorText(err)
    }
  }

  // ---------------------------------------------------------------- Teach › Show me a sign

  private showPage(): Extract<SettingsPage, { page: 'teachShow' }> | null {
    const view = this.view
    return view.kind === 'settings' && view.settings.page === 'teachShow' ? view.settings : null
  }

  /** Opens Show me a sign, waiting for one repetition (or saying why no guess can be made). */
  private openShowSign(): void {
    const reason = this.services.signGuessUnavailable()
    this.setView({ kind: 'settings', settings: { page: 'teachShow', phase: 'waiting', ...(reason ? { reason } : {}) } })
  }

  /** Show me a sign: a movement started. */
  showSignListening(): void {
    const page = this.showPage()
    if (page?.phase === 'waiting') this.setView({ kind: 'settings', settings: { page: 'teachShow', phase: 'listening' } })
  }

  /** Show me a sign: the movement was no repetition (a raise, too short, too long): wait for the next. */
  showSignEnded(reason?: string): void {
    const page = this.showPage()
    if (page?.phase !== 'waiting' && page?.phase !== 'listening') return
    if (page.phase === 'waiting' && !reason) return
    this.setView({ kind: 'settings', settings: { page: 'teachShow', phase: 'waiting', ...(reason ? { reason } : {}) } })
  }

  /** Show me a sign: one clean repetition. The LLM names it; its guesses are offered with the list as a way out. */
  showSign(movement: UnknownMovement): void {
    const page = this.showPage()
    if (page?.phase !== 'waiting' && page?.phase !== 'listening') return
    const unavailable = this.services.signGuessUnavailable()
    if (unavailable) return this.setView({ kind: 'settings', settings: { page: 'teachShow', phase: 'waiting', reason: unavailable } })
    const identifying: View = { kind: 'settings', settings: { page: 'teachShow', phase: 'identifying' } }
    this.setView(identifying)
    const abort = new AbortController()
    const current = (): boolean => this.view === identifying
    this.signGuess?.abort()
    this.signGuess = abort
    this.lastGuessAt = Date.now()
    this.llmCalls.set(abort, current)
    void (async () => {
      const res = await this.identify(movement, current, abort)
      if (this.signGuess === abort) this.signGuess = null
      if (!current()) return // went back meanwhile
      const waiting = (reason: string): void =>
        this.setView({ kind: 'settings', settings: { page: 'teachShow', phase: 'waiting', reason } })
      if (!res.ok) return waiting(res.error)
      if (!res.value.length) return waiting(NOT_A_SIGN)
      const guess: View = { kind: 'settings', settings: { page: 'teachShow', phase: 'guess', guesses: res.value } }
      this.shown = { guess, features: movement.features, hands: res.hands }
      this.setView(guess)
    })()
  }

  /** A guess picked on Show me a sign: that one repetition is learned as the word ("Learned HELLO"). */
  private confirmShownSign(gloss: string): void {
    const shown = this.shown
    this.shown = null
    if (!shown || this.view !== shown.guess) return
    void this.teachLearned(gloss, [wordTemplate(gloss, learnedFrames(shown.features, shown.hands.get(gloss)))])
  }

  /** Loads the recorded signs (signs.json) into the store; recognition follows it, and so does an open teach page. */
  async loadTemplates(): Promise<void> {
    const saved = await window.fastasl?.getTemplates().catch(() => null)
    if (!saved) return
    const { templates } = saved
    setApp({ templates })
    const view = this.view
    if (view.kind !== 'settings') return
    const page = view.settings
    if (page.page === 'teachPick') this.setView({ kind: 'settings', settings: { ...page, recorded: countSigns(templates) } })
    if (page.page === 'teachSpell') this.setView({ kind: 'settings', settings: { ...page, canSpell: hasLetters(templates) } })
  }

  private settingsPick(page: SettingsPage, index: number): void {
    switch (page.page) {
      case 'root':
        if (index === 0) this.setView({ kind: 'settings', settings: this.teachList() })
        else if (index === 1) this.startNewGesture()
        else if (index === 2) void this.openGestureList()
        else if (index === 3) this.openCameraSettings()
        else if (index === 4) this.setView({ kind: 'settings', settings: { page: 'sensitivity', current: getApp().sensitivity } })
        return
      case 'teachPick': {
        const options = settingsOptions(page)
        const label = options[index]
        if (index === 0) return this.openShowSign()
        if (index === options.length - 1) {
          const canSpell = hasLetters(getApp().templates)
          this.setView({ kind: 'settings', settings: { page: 'teachSpell', letters: '', canSpell } })
          return
        }
        const kind = label.length === 1 ? 'letter' : 'word'
        this.setView({ kind: 'settings', settings: { page: 'teachRecord', label, kind, done: 0, total: TEACH_REPS[kind] } })
        return
      }
      case 'teachShow': {
        const guesses = page.guesses ?? []
        if (index < guesses.length) this.confirmShownSign(guesses[index])
        else this.setView({ kind: 'settings', settings: this.teachList() })
        return
      }
      case 'newGesturePick': {
        const options = settingsOptions(page)
        if (index === options.length - 1) this.signNewTask()
        else this.startShapeCapture(options[index])
        return
      }
      case 'gestures': {
        const gesture = page.gestures[page.offset + index]
        if (gesture) this.setView({ kind: 'settings', settings: { page: 'gestureDetail', gesture } })
        return
      }
      case 'gestureDetail':
        if (index === 0) void this.runShortcut(page.gesture.id, 'ready')
        else if (index === 1 && !page.gesture.builtin) void this.deleteGesture(page.gesture.id)
        return
      case 'camera':
        this.chooseCamera(index, page)
        return
      case 'sensitivity': {
        const sensitivity = (['low', 'medium', 'high'] as const)[index]
        setApp({ sensitivity })
        void window.fastasl?.saveSettings({ sensitivity })
        this.setView({ kind: 'settings', settings: { page: 'sensitivity', current: sensitivity } })
        return
      }
    }
  }

  startNewGesture(task?: string): void {
    void (async () => {
      const recent = (await window.fastasl?.getRecentTasks().catch(() => [])) ?? []
      const tasks = [task, this.lastCompleted?.intent, ...recent.map((t) => t.intent)].filter(
        (t, i, all): t is string => Boolean(t) && all.indexOf(t) === i
      )
      this.setView({ kind: 'settings', settings: { page: 'newGesturePick', tasks: tasks.slice(0, 4) } })
    })()
  }

  /**
   * New gesture › Sign a new task: back to Ready (in Command mode, where signs build a
   * sentence), and the phrase proceeded next becomes the task (taskSigned).
   */
  private signNewTask(): void {
    if (getApp().mode !== 'command') this.switchMode('command')
    this.resetPhrase()
    this.signingTask = true
    this.setView(this.idleView())
  }

  /**
   * New gesture › hold: counts 3, 2, 1 down, then records the shape. app/shapeInput sends the
   * verdict to shapeCaptured; without camera frames none comes, and the timeout says why.
   */
  private startShapeCapture(task: string, countdown = COUNTDOWN_FROM): void {
    this.setView({ kind: 'settings', settings: { page: 'newGestureHold', task, countdown } })
    if (countdown > 0) return this.later(COUNTDOWN_TICK_MS, () => this.startShapeCapture(task, countdown - 1))
    this.later(CAPTURE_TIMEOUT_MS, () =>
      this.shapeCaptured({ ok: false, reason: getApp().cameraOn ? CAPTURE_REASONS.noHand : 'The camera is off. Turn it on first.' })
    )
  }

  /** The recorded shape was judged (customShapes.captureShape): save it, or say why not so it can be made again. */
  shapeCaptured(capture: ShapeCapture): void {
    const view = this.view
    if (!isCapturingShape(view)) return
    if (!capture.ok) return this.setView({ kind: 'settings', settings: { ...view.settings, reason: capture.reason } })
    void this.saveGesture(view.settings, capture.shape)
  }

  /** Adds the gesture to gestures.json; the toast leads to My gestures, where it is listed. */
  private async saveGesture(page: HoldPage, shape: number[][]): Promise<void> {
    this.clearTimers() // the recording's timeout
    const from = this.view
    let saved: { gesture: CustomGesture; all: CustomGesture[] } | null = null
    let error = ''
    try {
      // Added to the file, not the store: a shortcut may have been compiled into it meanwhile.
      const gestures = (await window.fastasl?.getGestures()) ?? []
      const gesture: CustomGesture = { id: `gesture-${Date.now()}`, name: nextGestureName(gestures), task: page.task, shape, createdAt: Date.now() }
      const all = [...gestures, gesture]
      await window.fastasl?.saveGestures(all)
      setApp({ gestures: all })
      saved = { gesture, all }
    } catch (err) {
      error = errorText(err)
    }
    if (this.view !== from) {
      if (saved) this.notify(`Gesture saved: ${saved.gesture.name}`)
      return
    }
    if (!saved) return this.setView({ kind: 'settings', settings: { ...page, reason: `Couldn't save it: ${error}` } })
    const { gesture, all } = saved
    this.showToast({
      kind: 'toast',
      title: 'Gesture saved',
      subtitle: `${gesture.name} · ${gesture.task}`,
      ok: true,
      returnTo: gestureList(all, gesture.id)
    })
  }

  /** Loads the gesture shortcuts (gestures.json) into the store; the shape matcher follows it. */
  async loadGestures(): Promise<CustomGesture[]> {
    const gestures = (await window.fastasl?.getGestures().catch(() => null)) ?? getApp().gestures
    setApp({ gestures })
    return gestures
  }

  private async openGestureList(focusId?: string): Promise<void> {
    const gestures = await this.loadGestures()
    this.setView({ kind: 'settings', settings: gestureList(gestures, focusId) })
  }

  private gesturePage(page: Extract<SettingsPage, { page: 'gestures' }>, dir: 1 | -1): void {
    const offset = page.offset + dir * GESTURE_PAGE
    if (offset < 0 || offset >= page.gestures.length) return
    this.setView({ kind: 'settings', settings: { ...page, offset } })
  }

  private async deleteGesture(id: string): Promise<void> {
    const gestures = (await window.fastasl?.getGestures().catch(() => [])) ?? []
    await window.fastasl?.saveGestures(gestures.filter((g) => g.id !== id))
    await this.openGestureList()
  }

  /** Camera source, showing the store's settings (loaded at launch, changed only by this page and cameraStatus). */
  private openCameraSettings(): void {
    const { cameraSource, streamUrl } = getApp()
    this.setView({ kind: 'settings', settings: { page: 'camera', current: cameraSource.kind, url: streamUrl } })
  }

  private chooseCamera(index: number, page: Extract<SettingsPage, { page: 'camera' }>): void {
    // Typing a URL needs the keyboard: the page opens its field, which takes focus while open.
    if (index === 2) return this.setView({ kind: 'settings', settings: { ...page, editing: true } })
    if (index === 1 && !page.url) return this.notify('Set a stream URL first (option 3)')
    const source: CameraSource = index === 0 ? { kind: 'builtin' } : { kind: 'mjpeg', url: page.url }
    this.switchCamera(source)
    this.setView({ kind: 'settings', settings: { page: 'camera', current: source.kind, url: page.url } })
  }

  /** Camera source › Edit stream URL, Return: saves the URL and switches to that stream at once. */
  saveStreamUrl(text: string): void {
    const view = this.view
    if (view.kind !== 'settings' || view.settings.page !== 'camera') return
    const url = text.trim()
    if (!STREAM_URL.test(url)) return this.notify('Enter a URL starting with http://')
    this.notify(null)
    this.switchCamera({ kind: 'mjpeg', url }, url)
    this.setView({ kind: 'settings', settings: { page: 'camera', current: 'mjpeg', url } })
  }
}

/** Mock poses used for the feed per view when no camera is running. */
export function mockPoseFor(view: View): typeof live.mockPose {
  switch (view.kind) {
    case 'recognizing':
      return view.token ? 'fist' : 'twoHands'
    case 'building':
      return 'c'
    case 'agentReady':
      return 'point'
    case 'working':
      return 'point'
    case 'confirm':
      return 'thumbsUp'
    case 'done':
      return 'ok'
    case 'toast':
      return 'peace'
    default:
      return 'palm'
  }
}
