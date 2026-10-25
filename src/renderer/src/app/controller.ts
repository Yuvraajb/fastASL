import { parseAsk } from '@shared/ask'
import { mergeTemplates } from '@shared/templatePack'
import type {
  AgentEvent,
  AgentResult,
  AgentStep,
  CameraSource,
  CustomGesture,
  EnvKey,
  IntentResult,
  Mode,
  Result,
  ShortcutRunResult,
  SignTemplate,
  ViewAction
} from '@shared/types'
import { CAPTURE_REASONS, type ShapeCapture } from '../engine/gestures/customShapes'
import { getApp, setApp } from './store'
import type { Services } from './services'
import {
  isChatCard,
  isReply,
  MAX_CHAT,
  type Answer,
  type ChatMessage,
  type ConfirmStatus,
  type SettingsPage,
  type Token,
  type View
} from './types'
import { live } from './live'

type HoldPage = Extract<SettingsPage, { page: 'newGestureHold' }>

/** A chat message before the controller gives it an id. */
type WithoutId<M> = M extends unknown ? Omit<M, 'id'> : never
export type NewChatMessage = WithoutId<ChatMessage>

/** The chat's live bubble while the interpreter reads the phrase, before the agent's own steps. */
export const UNDERSTANDING_STEP: AgentStep = { id: 'understanding', label: 'Understanding', status: 'current' }
/** The label on a message signed as a new gesture's task (New gesture › Sign a new task). */
export const GESTURE_TASK_LABEL = 'Gesture task'
/** The transcript's line when the agent was stopped, or a sent phrase was dropped before it reached the agent. */
export const STOPPED_NOTE = 'Stopped'
export const CANCELLED_NOTE = 'Cancelled'
/** Chat message ids, unique for the session (the transcript outlives a controller swapped in tests). */
let chatSeq = 0

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

/** A toast's countdown; one with a screenshot thumbnail stays long enough for a thumbs up to open it. */
export const TOAST_MS = 2600
export const TOAST_THUMB_MS = 6000
export const toastDuration = (view: { thumb?: string }): number => (view.thumb ? TOAST_THUMB_MS : TOAST_MS)
/** A screenshot thumbnail that takes longer than this is left out rather than holding up the card. */
const THUMB_WAIT_MS = 1500
/** Why typing failed (often a permission to grant in System Settings) needs time to read. */
const TYPING_NOTICE_MS = 8000
/** The dictation card keeps this much of the typed text (it shows the last two lines). */
const DICTATION_KEEP = 120
/** Typed text continues a run (spaced from it) this long after the last typing, card or not. */
const TYPED_RUN_MS = 2 * 60_000

/** Below this the interpreter is guessing: what was signed goes to the agent instead of its reading. */
export const LOW_CONFIDENCE = 0.6

/** New gesture › hold: 3, 2, 1, then app/shapeInput records the shape (CAPTURE_MS). */
const COUNTDOWN_FROM = 3
const COUNTDOWN_TICK_MS = 1000
/** No verdict this long into a recording means no camera frames came (camera off or failed). */
const CAPTURE_TIMEOUT_MS = 2500
const SIGN_TASK_HINT = 'Sign the task for your gesture'
/** Ready's hint while the caption camera is open. */
const CAPTIONS_HINT = 'Captions on: what you sign goes to the call, not the agent'
/** While the caption window is open, how often the front app is checked: captions are for FaceTime only. */
const FRONT_APP_CHECK_MS = 1000

/** The FaceTime app (its name, or its bundle id). */
const isFaceTime = (app: { name: string; bundleId?: string }): boolean => /^facetime$/i.test(app.name) || app.bundleId === 'com.apple.FaceTime'
/** Gestures per page of My gestures (two-line rows). */
export const GESTURE_PAGE = 4
/** What Settings › Camera source accepts as a stream URL (the proxy checks the rest). */
const STREAM_URL = /^https?:\/\/\S+$/i
/** Why a stream gave way to the MacBook camera: long enough to read. */
const CAMERA_FALLBACK_NOTICE_MS = 8000
const BUILTIN_CAMERA: CameraSource = { kind: 'builtin' }
export const cameraFallbackNotice = (error: string): string => `${error}. Using the MacBook camera.`

/** The agent run on the card. Only its events are shown; anything else is stale. */
interface AgentRunState {
  /**
   * A command's run is null until agentRun replies; its events wait in `held` until then. A 'started'
   * can't name it: a run main queued earlier (a shortcut's agent fallback) may announce itself first.
   */
  runId: string | null
  intent: string
  /** Run by a gesture shortcut: the shortcut's toast shows the result, on the plain Working card meanwhile. */
  shortcut: boolean
  /** A command's conversation card: what the user signed (and for which quick-menu pick). */
  said: string
  prefix?: string
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

/** Tools that only look things up: a run of nothing else is answered in the model's words. */
const LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  'get_frontmost_app',
  'contacts_find',
  'calendar_list_events',
  'notes_search',
  'notes_read',
  'spotify_search'
])

/**
 * The agent's result as the conversation card shows it. No tool ran, or only lookups did, and the
 * model answered: its reply is the answer (a greeting, the time, tomorrow's meetings, or why it
 * couldn't call Mom), not a lookup's headline like "Found 18 contacts". Otherwise the title and
 * subtitle come from the tool outcomes, with the model's own line under them.
 */
export function answerFor(result: AgentResult, complete: boolean): Answer {
  // A question with choices ("ASK: When? | Morning | Evening"): the question is the text, the choices are picked.
  const question = parseAsk(result.reply)
  if (question) return { ok: true, text: question.question, ask: { options: question.options } }
  const lookupsOnly = result.evidence.every((e) => LOOKUP_TOOLS.has(e.tool))
  if (lookupsOnly && result.reply) return { ok: true, text: result.reply }
  return {
    ok: complete,
    title: result.title,
    subtitle: result.subtitle,
    ...(result.reply ? { text: result.reply } : {}),
    ...(result.view ? { view: result.view } : {})
  }
}

const IMAGE_FILE = /\.(png|jpe?g|heic|tiff?|gif)$/i

/** The image a result opens (take_screenshot's file), which the card shows as a thumbnail. */
export function imagePath(view: ViewAction | undefined): string | null {
  return view?.kind === 'openFile' && IMAGE_FILE.test(view.path) ? view.path : null
}

/** IPC calls can also reject (main-process crash); treat that as a soft failure too. */
function settled<T>(call: Promise<Result<T>>): Promise<Result<T>> {
  return call.catch((err: unknown) => ({ ok: false as const, error: errorText(err) }))
}

/** Join recognized tokens into display text. Consecutive letters form one word. */
export function assembleSentence(tokens: Token[]): string {
  const text = phraseWords(tokens).join(' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

/** The phrase's words: each sign, and each run of spelled letters as one word. */
export function phraseWords(tokens: Token[]): string[] {
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
  return words
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

/** Command and Spell mode's views where a recognized sign joins (or starts) the phrase. */
function collectsPhrase(view: View): boolean {
  return view.kind === 'ready' || view.kind === 'recognizing' || view.kind === 'building' || isReply(view)
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
    case 'conversation':
      // The reply stays ready for the next message: Ready's gestures (thumbs up opens the result).
      // A question with choices is answered by holding up that many fingers.
      if (view.phase === 'reply') {
        const ready = activeGestures({ kind: 'ready' }, mode)
        return view.answer?.ask ? new Set<GestureName>([...ready, 'fingers']) : ready
      }
      return new Set(['fist'])
    case 'working':
      return new Set(['fist'])
    case 'confirm':
      return new Set(['thumbsUp', 'fist'])
    case 'didYouMean':
      // Swipe left edits what a spelling list was made from: the spelled letters.
      if (view.purpose === 'sign') return new Set(['fingers', 'fist', 'thumbsUp'])
      return new Set(['fingers', 'fist', 'thumbsUp', 'swipeLeft'])
    case 'quickMenu':
      return new Set(['fingers', 'fist'])
    case 'dictation':
      return new Set(['fist', 'swipeLeft', 'swipeRight', 'swipeUp'])
    case 'toast':
      // A screenshot's thumbnail: thumbs up opens it in Preview.
      return new Set(view.thumb && view.view ? ['thumbsUp', 'fist'] : ['fist'])
    case 'settings':
      switch (view.settings.page) {
        case 'teachSpell':
          return new Set(['thumbsUp', 'fist', 'swipeLeft'])
        case 'teachRecord':
          // Letters are held still and S, T, M, N read as a fist: a swipe goes back instead.
          return new Set([view.settings.kind === 'letter' ? 'swipeLeft' : 'fist'])
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
  // The reply brings Ready's gestures: a thumbs up or fist already up while the agent worked must be made again.
  if (view.kind === 'conversation') return `conversation:${view.phase}`
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
    case 'dictation':
      return true
    case 'conversation':
      // The reply: the next sign starts the next message.
      return view.phase === 'reply'
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
    case 'quickMenu':
      return view.options
    case 'conversation':
      return view.phase === 'reply' ? (view.answer?.ask?.options ?? []) : []
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
/** Signs per page of the teach list: with Spell a new word, four rows (fingers 1-4). */
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
      return [...TEACH_LABELS.slice(page.offset, page.offset + TEACH_PAGE), 'Spell a new word']
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

/** "Gesture 1", "Gesture 2"…: the first number no saved gesture uses. */
export function nextGestureName(gestures: readonly Pick<CustomGesture, 'name'>[]): string {
  const names = new Set(gestures.map((g) => g.name))
  let n = 1
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
  /**
   * The stopped run: main still reports a write it had already made. `toast`: the Stopped toast
   * (a shortcut's run), or null for a command's run, which the chat transcript reports.
   */
  private stopped: { runId: string; toast: View | null } | null = null
  /** The chat's live bubble: "Understanding", then the agent's steps, until the run ends. */
  private liveId: string | null = null
  /** A phrase sent at phrase end and still with the interpreter: its bubble, which the agent's sentence updates. */
  private sent: { youId: string } | null = null
  /** The inline Confirm bubble waiting for a thumbs up or a fist. */
  private confirmId: string | null = null
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
  /** The caption window is open: whether FaceTime is the app in front (see startFrontAppCheck). */
  private faceTimeInFront = true
  private frontAppTimer: ReturnType<typeof setInterval> | null = null
  constructor(private services: Services) {
    this.subscribe()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.clearTimers()
    this.stopFrontAppCheck()
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
    if (this.signingTask) return { kind: 'ready', hint: SIGN_TASK_HINT }
    return this.captionsApply() ? { kind: 'ready', hint: CAPTIONS_HINT } : { kind: 'ready' }
  }

  /** The signed words go, the context they were signed for (quick-menu prefix, a gesture's task) stays. */
  private startNextPhrase(): void {
    this.tokens = []
    this.forgetInterpretation()
    this.syncComposing()
  }

  private resetPhrase(): void {
    this.tokens = []
    this.forgetInterpretation()
    this.intentPrefix = undefined
    this.signingTask = false
    this.abandonSent()
    this.syncComposing()
  }

  // ---------------------------------------------------------------- chat transcript

  /** Adds messages at the end of the transcript, which keeps the last MAX_CHAT. Returns their ids. */
  private postChat(...messages: NewChatMessage[]): string[] {
    const posted = messages.map((m) => ({ ...m, id: `m${++chatSeq}` }) as ChatMessage)
    setApp({ chat: [...getApp().chat, ...posted].slice(-MAX_CHAT) })
    return posted.map((m) => m.id)
  }

  /** Changes one message in place (one that is gone already is left alone). */
  private patchChat(id: string, patch: (m: ChatMessage) => ChatMessage): void {
    const chat = getApp().chat
    if (!chat.some((m) => m.id === id)) return
    setApp({ chat: chat.map((m) => (m.id === id ? patch(m) : m)) })
  }

  /** Shows `steps` in the live bubble, which stays the last one: anything added since puts it back at the end. */
  private showLive(steps: AgentStep[]): void {
    const chat = getApp().chat
    const i = this.liveId === null ? -1 : chat.findIndex((m) => m.id === this.liveId)
    if (i >= 0 && i === chat.length - 1) {
      setApp({ chat: chat.map((m, j) => (j === i && m.kind === 'steps' ? { ...m, steps } : m)) })
      return
    }
    if (i >= 0) setApp({ chat: chat.filter((_, j) => j !== i) })
    this.liveId = this.postChat({ from: 'agent', kind: 'steps', steps })[0]
  }

  /** The live bubble goes, and `replacement` (the answer, a note) takes its place at the end. */
  private endLive(...replacement: NewChatMessage[]): void {
    const id = this.liveId
    this.liveId = null
    if (id !== null) setApp({ chat: getApp().chat.filter((m) => m.id !== id) })
    if (replacement.length) this.postChat(...replacement)
  }

  /** The inline Confirm is answered, or its run ended without an answer (nothing ran: cancelled). */
  private settleConfirm(status: Exclude<ConfirmStatus, 'pending'>): void {
    const id = this.confirmId
    this.confirmId = null
    if (id !== null) this.patchChat(id, (m) => (m.kind === 'confirm' ? { ...m, status } : m))
  }

  /** A phrase sent but not yet with the agent was dropped (a fist, the X, a collapse): the transcript says so. */
  private abandonSent(): void {
    if (!this.sent) return
    this.sent = null
    this.endLive({ from: 'agent', kind: 'note', text: CANCELLED_NOTE })
  }

  /** The composing bubble follows the phrase: its tokens, and what it is signed for. */
  private syncComposing(): void {
    const label = this.intentPrefix ?? (this.signingTask ? GESTURE_TASK_LABEL : undefined)
    setApp({ composing: { tokens: [...this.tokens], ...(label ? { label } : {}) } })
  }

  /** The agent's answer as a bubble: its words, what it did, or (`failed`) why it couldn't start or finish. */
  private answerMessage(answer: Answer, failed: boolean): NewChatMessage {
    if (failed) {
      return { from: 'agent', kind: 'error', title: answer.title ?? "Couldn't finish", ...(answer.subtitle ? { subtitle: answer.subtitle } : {}) }
    }
    if (answer.title === undefined) return { from: 'agent', kind: 'text', text: answer.text ?? '', ...(answer.ask ? { ask: { options: answer.ask.options } } : {}) }
    return { from: 'agent', kind: 'result', answer }
  }

  /** A click on a result in the transcript (its screenshot): opens what it made, as a thumbs up on the reply does. */
  openChatResult(id: string): void {
    const m = getApp().chat.find((x) => x.id === id)
    if (m?.kind === 'result' && m.answer.view) this.openResult(m.answer.view)
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

  /** The caption camera window opened or closed (see endPhrase); Ready's hint follows. */
  setCaptioning(open: boolean): void {
    if (getApp().captioning === open) return
    setApp({ captioning: open })
    if (open) this.startFrontAppCheck()
    else this.stopFrontAppCheck()
    this.syncOnCall()
    // Captions are Command mode's streamed words (Spell mode reads letters, Dictation types them),
    // and the mode stays Command while the window is open (see cycleMode).
    if (open && getApp().mode !== 'command') return this.switchMode('command')
    if (this.view.kind === 'ready' && !this.intentPrefix && !this.signingTask) this.setView(this.idleView())
  }

  /** Whether signing is captioning the call now: the caption window is open and FaceTime is the app in front. Anywhere else the agent hears it. */
  private captionsApply(): boolean {
    return getApp().captioning && this.faceTimeInFront
  }

  /** While the caption window is open, FaceTime being in front (or not) decides where signing goes. */
  private startFrontAppCheck(): void {
    this.faceTimeInFront = true // the window opens with a call, so FaceTime is where the user is until a check says otherwise
    this.stopFrontAppCheck()
    const check = async (): Promise<void> => {
      const app = await this.services.frontmostApp().catch(() => null)
      if (!app || !getApp().captioning) return // unknown: keep what was known
      const inFront = isFaceTime(app)
      if (inFront === this.faceTimeInFront) return
      this.faceTimeInFront = inFront
      this.syncOnCall()
      // Ready's hint says where signing goes.
      if (this.view.kind === 'ready' && !this.intentPrefix && !this.signingTask) this.setView(this.idleView())
    }
    void check()
    this.frontAppTimer = setInterval(() => void check(), FRONT_APP_CHECK_MS)
  }

  /** On a call the card shrinks to the pill (the view stays the same, so signing is still read). */
  private syncOnCall(): void {
    const onCall = this.captionsApply()
    if (getApp().onCall !== onCall) setApp({ onCall })
  }

  private stopFrontAppCheck(): void {
    if (this.frontAppTimer) clearInterval(this.frontAppTimer)
    this.frontAppTimer = null
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
    // The caption camera keeps Command mode: a signing movement read as a swipe once switched to
    // Spell mode (letters only), and the captions stopped.
    if (getApp().captioning) return
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
    setApp({ mode: getApp().captioning ? 'command' : mode })
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
        // Hands down ends the phrase, which goes to the agent at once (as do a thumbs up and a swipe right).
        if (g === 'thumbsUp' || g === 'swipeRight' || g === 'handsDown') this.endPhrase()
        else if (g === 'swipeLeft') this.deleteLastToken()
        else if (g === 'fist') this.cancel()
        return
      case 'conversation':
        if (view.phase === 'reply') {
          // A question with choices: fingers pick the choice, a thumbs up the first.
          if (view.answer?.ask) {
            if (g === 'fingers' && input.count) return this.pickOption(input.count - 1)
            if (g === 'thumbsUp') return this.pickOption(0)
          }
          // A thumbs up opens what the agent made (the screenshot in Preview); with nothing to open it is Ready's.
          if (g === 'thumbsUp' && view.answer?.view) return this.openResult(view.answer.view)
          return this.readyGesture(input)
        }
        if (g !== 'fist') return
        // Before the agent starts there is nothing to stop: the phrase is dropped.
        if (view.phase === 'understanding') this.cancel()
        else this.stopAgent()
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
        else if (g === 'fist') return this.cancel()
        return
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
        if (g === 'thumbsUp' && view.view) this.openFromToast(view)
        else if (g === 'fist') this.leaveToast(view.returnTo)
        return
      case 'settings': {
        const page = view.settings
        if (g === 'fingers' && input.count) this.pickOption(input.count - 1)
        else if (g === 'fist') this.settingsBack()
        else if (page.page === 'teachPick' && (g === 'swipeLeft' || g === 'swipeRight')) this.teachPage(g === 'swipeRight' ? 1 : -1)
        else if (page.page === 'teachSpell' && g === 'swipeLeft') this.deleteTeachLetter(page.letters)
        else if (page.page === 'teachSpell' && g === 'thumbsUp') this.confirmTeachWord()
        else if (page.page === 'teachRecord' && g === 'swipeLeft') this.settingsBack()
        
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
    // Outside Spell mode a held fist is still taken (so it is not read as an S or a YES) but does
    // nothing: a hand resting in a fist between signs hid the card, which stopped recognition and
    // the caption camera with it. The card's chevron hides it.
    else if (g === 'fist' && getApp().mode === 'spell') this.collapse()
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
      else if (view.kind === 'conversation' && view.phase === 'working') this.stopAgent()
      else if (view.kind === 'confirm') void this.respondConfirm(false)
      else if (view.kind === 'settings') this.settingsBack()
      else if (view.kind === 'toast') this.leaveToast(view.returnTo)
      else {
        // The X on the dictation card starts a new run of text: no space before the next sign.
        if (view.kind === 'dictation') this.lastTyped = null
        this.cancel()
      }
      return
    }
    if (target === 'proceed') {
      if (view.kind === 'building' || view.kind === 'recognizing') this.endPhrase()
      return
    }
    // primary / secondary
    switch (view.kind) {
      case 'confirm':
        void this.respondConfirm(target === 'primary')
        return
      case 'didYouMean':
        if (target === 'primary') this.pickOption(0)
        else this.change()
        return
      case 'conversation':
        // The reply's thumbnail (or result) opens what the agent made.
        if (target === 'primary' && view.answer?.view) this.openResult(view.answer.view)
        return
      case 'toast':
        if (target === 'primary' && view.view) this.openFromToast(view)
        else if (target === 'secondary') this.leaveToast(view.returnTo)
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
      return this.dictate(token, view.kind === 'dictation' ? view.text : '')
    }
    if (view.kind === 'didYouMean' && view.purpose === 'sign') return
    if (!collectsPhrase(view)) return
    // A sign on the agent's reply starts the next message: the card moves on to it.
    if (isReply(view)) this.startNextPhrase()
    this.tokens.push(token)
    this.forgetInterpretation()
    // The chat's composing bubble shows it at once, as the forming sentence.
    this.syncComposing()
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
    // No "Did you mean" list to stop at: a close call between signs takes the best guess, and the
    // agent reads the sentence in its context (a wrong word is deleted with a swipe left).
    this.token({ text: options[0], kind: 'word' })
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
    this.forgetInterpretation()
    this.syncComposing()
    if (!this.tokens.length) return this.cancel()
    this.resumeBuilding()
  }

  /** Back to the token strip with the phrase so far (or to listening when it is empty). */
  private resumeBuilding(): void {
    if (!this.tokens.length) return this.setView({ kind: 'recognizing', token: null, isWord: false })
    this.setView({ kind: 'building', tokens: [...this.tokens], current: null, sentence: assembleSentence(this.tokens) })
  }

  /**
   * Hands down (or a thumbs up, a swipe right, the > button): Spell mode lists spellings; Command
   * mode sends the phrase, or captions it while the caption camera is open (a quick-menu pick or a
   * gesture's task still goes to the agent).
   */
  private endPhrase(): void {
    if (!this.tokens.length) return this.cancel()
    if (getApp().mode === 'spell') return void this.spellSuggestions()
    if (this.captionsApply() && !this.intentPrefix && !this.signingTask) return this.captionPhrase()
    void this.sendPhrase()
  }

  /**
   * The caption camera is open: the phrase is for the person on the call. It goes into the
   * transcript as sent (the caption shows it) and nowhere else, and the card is Ready for the next
   * phrase at once: an agent run would stop the signs, and the captions with them, until it ended.
   * A phrase of two signs or more then becomes English (TOMORROW MEETING WHAT TIME: "What time
   * is the meeting tomorrow?") when the captions model answers; until then, or if it can't, the
   * signs show as signed.
   */
  private captionPhrase(): void {
    const glosses = phraseWords(this.tokens)
    const [id] = this.postChat({ from: 'you', kind: 'text', text: assembleSentence(this.tokens) })
    this.resetPhrase()
    this.setView(this.idleView())
    if (glosses.length < 2) return
    void this.services.captionText(glosses).then((res) => {
      if (res.ok) this.patchChat(id, (m) => (m.kind === 'text' ? { ...m, text: res.value } : m))
    })
  }

  /**
   * Command mode's phrase end: the conversation card at once ("Understanding"), the interpreter,
   * then straight to the agent, with nothing to confirm in between. An interpreter that fails
   * (no key, a rate limit, a timeout) or is unsure doesn't hold the message up: what was signed
   * goes instead. Writes are still confirmed by the agent's Confirm card.
   */
  private async sendPhrase(): Promise<void> {
    const raw = assembleSentence(this.tokens)
    const prefix = this.intentPrefix
    const pending = this.interpretPhrase()
    const understanding: View = { kind: 'conversation', phase: 'understanding', said: raw, ...(prefix ? { prefix } : {}), steps: [] }
    this.setView(understanding)
    // The chat: the composing bubble becomes a sent one (the signed words until the interpreter
    // answers), and "Understanding" comes up under it.
    const label = prefix ?? (this.signingTask ? GESTURE_TASK_LABEL : undefined)
    const [youId] = this.postChat({ from: 'you', kind: 'text', text: raw, ...(label ? { prefix: label } : {}) })
    this.sent = { youId }
    this.showLive([UNDERSTANDING_STEP])
    setApp({ composing: { tokens: [] } })
    const { result, error } = await pending
    if (this.view !== understanding) return // cancelled, collapsed or moved on meanwhile
    if (this.signingTask) return this.taskSigned(result, error, raw)
    if (error) this.notifyLlmError(error)
    const reading = result && result.confidence >= LOW_CONFIDENCE ? result : null
    const sentence = reading?.sentence.trim() || raw
    const intent = reading?.intent?.trim() || (prefix ? `${prefix}: ${sentence}` : sentence)
    void this.runAgent(intent, sentence, prefix)
  }

  /** The interpreter's reading of the phrase. Its call is the card's until the phrase changes or goes. */
  private interpretPhrase(): Promise<Interpretation> {
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
      this.clearLlmStatus(current)
      return res.ok ? { result: res.value, error: null } : { result: null, error: failureText(res) }
    })()
    this.interpretation = interpretation
    this.llmCalls.set(abort, current)
    this.dropStaleLlmCalls()
    return interpretation
  }

  /** New gesture › Sign a new task: Claude's intent (else the sentence) is the task; then the shape. */
  private taskSigned(result: IntentResult | null, error: string | null, rawSentence: string): void {
    if (error) this.notifyLlmError(error)
    const sentence = result?.sentence || rawSentence
    const task = result?.intent || (this.intentPrefix ? `${this.intentPrefix}: ${sentence}` : sentence)
    // A task, not a message: the bubble shows it, and no agent bubble follows.
    const sent = this.sent
    this.sent = null
    if (sent) this.patchChat(sent.youId, (m) => (m.from === 'you' ? { ...m, text: task } : m))
    this.endLive()
    this.resetPhrase()
    this.startShapeCapture(task)
  }

  /** "Edit" on a list (swipe left, the button): back to the phrase it came from. */
  private change(): void {
    this.resumeBuilding()
  }

  private pickOption(index: number): void {
    const view = this.view
    const options = optionsFor(view)
    if (index < 0 || index >= options.length) return
    const choice = options[index]
    switch (view.kind) {
      case 'didYouMean':
        if (view.purpose === 'sign') {
          this.tokens.push({ text: choice, kind: 'word' })
          this.forgetInterpretation()
          this.syncComposing()
          this.setView({
            kind: 'building',
            tokens: [...this.tokens],
            current: choice,
            sentence: assembleSentence(this.tokens)
          })
        } else {
          // Spellings still on their way would bring back the list being picked from.
          if (view.pending && !this.inserting) this.setView({ ...view, pending: false })
          void this.insert(choice, 'Typed')
        }
        return
      case 'conversation':
        this.answerQuestion(index, choice)
        return
      case 'quickMenu':
        // The details are signed next, and the pick prefixes them.
        this.intentPrefix = choice
        this.syncComposing()
        this.setView(this.idleView())
        return
      case 'settings':
        this.settingsPick(view.settings, index)
        return
    }
  }

  /** A choice of the agent's question: it stays in the transcript marked as picked, and goes back as the answer. */
  private answerQuestion(index: number, choice: string): void {
    const chat = getApp().chat
    const open = (m: ChatMessage): boolean => m.kind === 'text' && m.from === 'agent' && m.ask !== undefined && m.ask.picked === undefined
    const asked = [...chat].reverse().find(open)
    if (asked) this.patchChat(asked.id, (m) => (m.kind === 'text' && m.from === 'agent' && m.ask ? { ...m, ask: { ...m.ask, picked: index } } : m))
    void this.runAgent(choice, choice)
  }

  /** The raw letters can be picked at once; Claude's spellings join them when they arrive. */
  private async spellSuggestions(): Promise<void> {
    const letters = this.tokens.map((t) => t.text).join('')
    const list: View = { kind: 'didYouMean', options: [letters], purpose: 'spell', quote: letters }
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

  /**
   * Sends one message of the conversation: `intent` is what the agent is asked, `sentence` what
   * the user signed (shown as theirs on the card), `prefix` a quick-menu pick it was signed for.
   */
  async runAgent(intent: string, sentence: string, prefix?: string): Promise<void> {
    this.subscribe() // dispose() may have run (React StrictMode re-mounts App)
    // The bubble sent at phrase end, which now gets the interpreter's sentence (taken before the
    // reset below, which would call it dropped).
    const sent = this.sent
    this.sent = null
    // The run uses up the phrase, however it ends: the next sign, Settings and Ready start a new one.
    this.resetPhrase()
    // The agent may switch apps or type itself: what fastASL types next starts a new run.
    this.lastTyped = null
    this.steps = []
    // One run at a time: the main process stops whatever ran before, a pending shortcut included.
    this.shortcut = null
    const run: AgentRunState = { runId: null, intent, shortcut: false, said: sentence, ...(prefix ? { prefix } : {}), held: [] }
    this.agentRun = run
    if (sent) this.patchChat(sent.youId, (m) => (m.from === 'you' ? { ...m, text: sentence } : m))
    else this.postChat({ from: 'you', kind: 'text', text: sentence, ...(prefix ? { prefix } : {}) })
    this.showLive([])
    this.setView(this.runningView(run))
    const frontmost = await this.services.frontmostApp().catch(() => null)
    if (this.agentRun !== run) return // stopped before the agent started
    const res = await settled(this.services.agentRun({ intent, sentence, frontmost }))
    if (this.agentRun !== run) return // stopped meanwhile (clearRun released what it held)
    if (!res.ok) {
      this.clearRun()
      this.showAnswer(run, { ok: false, title: "Couldn't start the agent", subtitle: failureText(res) }, true)
      return
    }
    run.runId = res.value.runId
    // The held events can be told apart now: this run's are shown, the others dropped.
    for (const e of run.held.splice(0)) this.onAgentEvent(e)
  }

  /** The card while a run works: the conversation for a command, the plain Working card for a shortcut. */
  private runningView(run: AgentRunState): View {
    const steps = [...this.steps]
    if (run.shortcut) return { kind: 'working', intent: run.intent, steps }
    return { kind: 'conversation', phase: 'working', said: run.said, ...(run.prefix ? { prefix: run.prefix } : {}), steps }
  }

  /**
   * The agent's answer under what the user signed: the transcript's live bubble gives way to it.
   * `failed`: it couldn't start or finish (the error bubble). The card stays ready for the next message.
   */
  private showAnswer(run: AgentRunState, answer: Answer, failed = false): void {
    const prefix = run.prefix ? { prefix: run.prefix } : {}
    this.endLive(this.answerMessage(answer, failed))
    this.setView({ kind: 'conversation', phase: 'reply', said: run.said, ...prefix, steps: [...this.steps], answer })
  }

  /** A result that is a screenshot: its thumbnail first (waited for briefly), unless the card moves on meanwhile. */
  private async answerWithThumb(run: AgentRunState, answer: Answer, path: string): Promise<void> {
    const from = this.view
    const thumb = await this.loadThumb(path)
    const shown = thumb ? { ...answer, thumb } : answer
    if (this.view !== from) {
      // Stopped while it loaded (the transcript says so), or the card moved on (collapsed): then
      // the answer still replaces the live bubble, so no spinner is left behind.
      if (this.liveId !== null && !this.agentRun) this.endLive(this.answerMessage(shown, false))
      return
    }
    this.showAnswer(run, shown)
  }

  /** A screenshot's thumbnail from main (which serves only screenshots fastASL took), or nothing within THUMB_WAIT_MS. */
  private async loadThumb(path: string): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), THUMB_WAIT_MS)
    })
    let call: Promise<Result<string>>
    try {
      call = settled(this.services.imageThumb(path))
    } catch (err) {
      call = Promise.resolve({ ok: false, error: errorText(err) })
    }
    const res = await Promise.race([call, timeout])
    clearTimeout(timer)
    return res?.ok ? res.value : undefined
  }

  /** Thumbs up on a result: opens it (the screenshot in Preview). The card stays. */
  private openResult(view: ViewAction): void {
    void this.services.openTarget(view).catch(() => undefined)
  }

  /** Takes the run off the card. Events held for a run that was never named are then another run's. */
  private clearRun(): void {
    const held = this.agentRun?.held ?? []
    this.agentRun = null
    for (const e of held) this.onAgentEvent(e)
  }

  /**
   * Fist or X while working: the main process interrupts the run. A command's chat says "Stopped"
   * and is ready for the next message at once; a shortcut's run toasts.
   */
  private stopAgent(): void {
    const run = this.agentRun
    const chat = run ? !run.shortcut : this.view.kind === 'conversation'
    this.shortcut = null
    this.clearRun()
    this.agentStopped(run?.runId ?? null, chat)
    void this.services.agentStop().catch(() => undefined)
  }

  private agentStopped(runId: string | null, chat: boolean): void {
    if (chat) {
      this.settleConfirm('cancelled')
      this.endLive({ from: 'agent', kind: 'note', text: STOPPED_NOTE })
      this.setView(this.idleView())
      this.stopped = runId ? { runId, toast: null } : null
      return
    }
    this.toast('Stopped', 'The agent was interrupted', false)
    this.stopped = runId ? { runId, toast: this.view } : null
  }

  /**
   * Main reports a stopped run only when a write had already gone through (a sent message, say,
   * possibly finishing after the stop). The card says so, or the user might send it again: the
   * transcript under "Stopped" (and a notice when the chat isn't showing), or the toast.
   */
  private reportStopped(result: AgentResult): void {
    const stopped = this.stopped
    this.stopped = null
    if (stopped && stopped.toast === null) {
      this.postChat({ from: 'agent', kind: 'result', answer: { ok: false, title: result.title, subtitle: result.subtitle } })
      if (!isChatCard(this.view, getApp().mode)) this.notify(`${result.title} before you stopped`)
      return
    }
    if (this.view === stopped?.toast) this.toast(result.title, result.subtitle, false)
    else this.notify(`${result.title} before you stopped`)
  }

  /** Thumbs up / fist (or the buttons) on a Confirm: the agent carries on with the answer. */
  private async respondConfirm(approved: boolean): Promise<void> {
    const view = this.view
    if (view.kind !== 'confirm') return
    const run = this.agentRun
    if (view.inChat) {
      // The bubble keeps the answer, and the live steps come back under it.
      this.settleConfirm(approved ? 'allowed' : 'cancelled')
      if (run) this.showLive([...this.steps])
    }
    const stale: View = view.inChat ? this.idleView() : { kind: 'working', intent: '', steps: [...this.steps] }
    this.setView(run ? this.runningView(run) : stale)
    await this.services.agentRespond(view.requestId, approved)
  }

  /**
   * Every run opens with 'started'. A pending shortcut takes its runs on the card this way
   * (a replay that needs a confirm, then maybe the agent fallback).
   */
  private adopt(e: Extract<AgentEvent, { type: 'started' }>): void {
    if (!this.shortcut || (this.agentRun && !this.agentRun.shortcut)) return
    this.agentRun = { runId: e.runId, intent: e.intent, shortcut: true, said: e.intent, held: [] }
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
        // The chat's live bubble (held back while an inline Confirm waits: it returns under it).
        if (!run.shortcut && this.confirmId === null) this.showLive([...this.steps])
        const view = this.view
        if (view.kind === 'working' || (view.kind === 'conversation' && view.phase === 'working')) {
          this.setView({ ...view, steps: [...this.steps] })
        }
        return
      }
      case 'confirm': {
        if (run.shortcut) return this.setView({ kind: 'confirm', requestId: e.requestId, details: e.details })
        // A command's write is asked inline: the Confirm bubble takes the live bubble's place.
        this.settleConfirm('cancelled')
        this.endLive()
        const confirm: NewChatMessage = { from: 'agent', kind: 'confirm', requestId: e.requestId, details: e.details, status: 'pending' }
        this.confirmId = this.postChat(confirm)[0]
        this.setView({ kind: 'confirm', requestId: e.requestId, details: e.details, inChat: true })
        return
      }
      case 'done':
      case 'error':
      case 'stopped': {
        this.agentRun = null
        // A shortcut's result is its toast (runShortcut), which says the same thing.
        if (run.shortcut) return
        // A Confirm still open as the run ended (main stopped waiting) ran nothing.
        this.settleConfirm('cancelled')
        if (e.type === 'stopped') return this.agentStopped(run.runId, true) // stopped by the main process, not the user
        if (e.type === 'error') {
          const subtitle = failureText({ error: e.message, missingKey: e.missingKey })
          return this.showAnswer(run, { ok: false, title: "Couldn't finish", subtitle }, true)
        }
        // Title and subtitle come from tool results; an unfinished task says why in the subtitle.
        if (e.complete) this.lastCompleted = { intent: run.intent, title: e.result.title }
        const answer = answerFor(e.result, e.complete)
        const shot = imagePath(answer.view)
        if (shot) return void this.answerWithThumb(run, answer, shot)
        return this.showAnswer(run, answer)
      }
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
    // A shortcut's screenshot shows as a thumbnail, which thumbs up opens in Preview.
    const shot = res.ok ? imagePath(res.view) : null
    const thumb = shot ? await this.loadThumb(shot) : undefined
    if (this.shortcut !== pending) return // stopped, or replaced while the thumbnail loaded
    this.shortcut = null
    const meta = res.ok && res.compiled ? `compiled · ${(res.durationMs / 1000).toFixed(1)} s` : undefined
    const opens = res.ok && res.view ? { view: res.view, ...(thumb ? { thumb } : {}) } : {}
    this.showToast({ kind: 'toast', title: res.title, subtitle: res.subtitle, ok: res.ok, meta, returnTo, ...opens })
  }

  private showToast(toast: Extract<View, { kind: 'toast' }>): void {
    this.setView(toast)
    this.later(toastDuration(toast), () => this.leaveToast(toast.returnTo))
  }

  /** Thumbs up (or a click) on a toast's thumbnail: opens it in Preview, and the toast goes. */
  private openFromToast(toast: Extract<View, { kind: 'toast' }>): void {
    if (toast.view) this.openResult(toast.view)
    this.leaveToast(toast.returnTo)
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
    if (page.page === 'teachSpell') return this.setView({ kind: 'settings', settings: this.teachList() })
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

  /** Teach › record finished: add the new templates to signs.json, then back to the teach list. */
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
        if (index === options.length - 1) {
          const canSpell = hasLetters(getApp().templates)
          this.setView({ kind: 'settings', settings: { page: 'teachSpell', letters: '', canSpell } })
          return
        }
        const kind = label.length === 1 ? 'letter' : 'word'
        this.setView({ kind: 'settings', settings: { page: 'teachRecord', label, kind, done: 0, total: TEACH_REPS[kind] } })
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
    this.syncComposing()
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
    case 'conversation':
      return view.phase === 'reply' ? 'ok' : 'point'
    case 'working':
      return 'point'
    case 'confirm':
      return 'thumbsUp'
    case 'toast':
      return 'peace'
    default:
      return 'palm'
  }
}
