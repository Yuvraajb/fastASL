import type {
  AgentEvent,
  AgentRunRequest,
  FrontmostApp,
  IdentifySignRequest,
  InterpretRequest,
  IntentResult,
  Result,
  KeyStatus,
  ShortcutRunResult,
  SignGuess,
  SpellRequest,
  ViewAction
} from '@shared/types'
import { MOCK_SCREENSHOT_PATH, MOCK_SCREENSHOT_SUBTITLE, MOCK_SCREENSHOT_THUMB } from './mockThumb'
import { getApp } from './store'

/** Status lines of one LLM call while it runs, e.g. "Rate limited, retrying...". */
export type LlmStatusListener = (status: string) => void

/** What a call the card cancelled before it reached main answers. Nobody shows it. */
const CANCELLED = { ok: false as const, error: 'Cancelled' }

/** Everything the controller needs from the outside world. */
export interface Services {
  /** `onStatus` gets the call's progress lines; aborting `signal` cancels the call in main. */
  interpret(req: InterpretRequest, onStatus?: LlmStatusListener, signal?: AbortSignal): Promise<Result<IntentResult>>
  spellSuggest(req: SpellRequest, onStatus?: LlmStatusListener, signal?: AbortSignal): Promise<Result<string[]>>
  /** Guess, confirm, learn: names a movement the local recognizer didn't know. */
  identifySign(req: IdentifySignRequest, onStatus?: LlmStatusListener, signal?: AbortSignal): Promise<Result<SignGuess>>
  /**
   * Why identifySign can't answer at all (an unknown LLM_PROVIDER, its key missing), or null
   * when it can (local and mock need no key). When it can't, unknown movements are rejected as
   * before and no frames are captured.
   */
  signGuessUnavailable(): string | null
  /** Whether identifySign should get camera frames: not on the mock provider, which never looks at them. */
  sendsFrames(): boolean
  /** The caption camera: signed glosses (ASL order) as one English sentence, or an error to keep the glosses. */
  captionText(glosses: string[]): Promise<Result<string>>
  agentRun(req: AgentRunRequest): Promise<Result<{ runId: string }>>
  agentStop(): Promise<void>
  agentRespond(requestId: string, approved: boolean): Promise<void>
  onAgentEvent(cb: (event: AgentEvent) => void): () => void
  runShortcut(gestureId: string): Promise<ShortcutRunResult>
  frontmostApp(): Promise<FrontmostApp | null>
  typeText(text: string): Promise<Result<void>>
  openTarget(action: ViewAction): Promise<void>
  /** A screenshot's thumbnail (PNG data URL). Main serves only screenshots fastASL took. */
  imageThumb(path: string): Promise<Result<string>>
}

/** Real services: everything goes through the preload bridge to the main process. */
export function ipcServices(): Services {
  const api = window.fastasl
  // Ids main tags a call's status events with. The prefix keeps two windows' ids apart.
  const prefix = Math.random().toString(36).slice(2, 8)
  let calls = 0
  /**
   * Runs `call` with a fresh id, passes its status events to `onStatus` until it settles, and
   * cancels it in main when `signal` aborts. A call with neither gets no id.
   */
  function tracked<T>(
    onStatus: LlmStatusListener | undefined,
    signal: AbortSignal | undefined,
    call: (callId?: string) => Promise<Result<T>>
  ): Promise<Result<T>> {
    if (!onStatus && !signal) return call()
    if (signal?.aborted) return Promise.resolve(CANCELLED)
    const callId = `${prefix}-${++calls}`
    const off = onStatus
      ? api.onLlmStatus((e) => {
          if (e.callId === callId) onStatus(e.status)
        })
      : null
    const cancel = (): void => api.cancelLlm(callId)
    signal?.addEventListener('abort', cancel, { once: true })
    return call(callId).finally(() => {
      off?.()
      signal?.removeEventListener('abort', cancel)
    })
  }
  return {
    interpret: (req, onStatus, signal) => tracked(onStatus, signal, (callId) => api.interpret(req, callId)),
    spellSuggest: (req, onStatus, signal) => tracked(onStatus, signal, (callId) => api.spellSuggest(req, callId)),
    identifySign: (req, onStatus, signal) => tracked(onStatus, signal, (callId) => api.identifySign(req, callId)),
    // A renderer reloaded onto an older preload (dev hot reload) has no identifySign until a restart.
    signGuessUnavailable: () =>
      typeof api.identifySign === 'function' ? llmUnavailable(api.llmProvider, getApp().keyStatus) : 'Restart fastASL to guess signs',
    sendsFrames: () => api.llmProvider !== 'mock',
    captionText: (glosses) =>
      typeof api.captionsTranslate === 'function' ? api.captionsTranslate(glosses) : Promise.resolve({ ok: false, error: 'Restart fastASL' }),
    agentRun: (req) => api.agentRun(req),
    agentStop: () => api.agentStop(),
    agentRespond: (id, approved) => api.agentRespond(id, approved),
    onAgentEvent: (cb) => api.onAgentEvent(cb),
    runShortcut: (id) => api.runShortcut(id),
    frontmostApp: () => api.getFrontmostApp(),
    typeText: (text) => api.typeText(text),
    openTarget: (action) => api.openTarget(action),
    // A renderer reloaded onto an older preload (dev hot reload) has no thumbnails until a restart.
    imageThumb: (path) =>
      typeof api.getImageThumb === 'function'
        ? api.getImageThumb(path)
        : Promise.resolve({ ok: false, error: 'Restart fastASL to show thumbnails' })
  }
}

/**
 * Why LLM_PROVIDER (as main resolved it) can't answer, or null when it can: claude and gemini
 * need their key, local (Ollama) and mock need none, an unknown provider never can.
 */
export function llmUnavailable(provider: string, keys: KeyStatus): string | null {
  switch (provider) {
    case 'claude':
      return keys.ANTHROPIC_API_KEY ? null : 'Add ANTHROPIC_API_KEY to .env'
    case 'gemini':
      return keys.GEMINI_API_KEY ? null : 'Add GEMINI_API_KEY to .env'
    case 'local':
    case 'mock':
      return null
    case 'droid':
      return 'Sign guesses need a vision model: set LLM_PROVIDER=gemini or claude'
    default:
      return 'Set LLM_PROVIDER in .env to claude, gemini, local, mock or droid'
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The mock services' guess for any movement, like LLM_PROVIDER=mock's. */
export const MOCK_SIGN_GUESS: SignGuess = {
  is_sign: true,
  candidates: [
    { gloss: 'HELLO', confidence: 0.62, hands: 1 },
    { gloss: 'THANK YOU', confidence: 0.21, hands: 1 },
    { gloss: 'PLEASE', confidence: 0.09, hands: 1 }
  ]
}

/** The mock agent's answer to a message it doesn't act on, as the real agent answers in words. */
export function mockReply(message: string): string {
  const m = message.toLowerCase()
  if (/\btime\b|\bdate\b|\bday\b/.test(m)) return "It's 10:00 AM on Friday, October 25."
  if (/\bthank/.test(m)) return "You're welcome! Anything else?"
  return 'Hello! What can I do for you?'
}

/**
 * Mock services for UI work, screenshots and demos without keys. They script a believable
 * conversation so every state can be reached with the dev hotkeys: a greeting or a question is
 * answered in words, "screenshot" takes one (with a thumbnail), anything else books the calendar
 * event behind a Confirm card.
 */
export function mockServices(): Services {
  const listeners = new Set<(e: AgentEvent) => void>()
  const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))
  let pendingConfirm: ((approved: boolean) => void) | null = null
  /**
   * The run that may still emit: a stop or a newer run ends the one before, so a stopped run
   * never carries on (and reports) once the next message starts one.
   */
  let active = 0

  return {
    async interpret(req) {
      await wait(500)
      const s = req.sentence.toLowerCase()
      const reading = (patch: Partial<IntentResult>): Result<IntentResult> => ({
        ok: true,
        value: {
          sentence: req.sentence,
          intent: null,
          alternatives: [],
          confidence: 0.9,
          needs_confirmation: false,
          context_actions: [],
          ...patch
        }
      })
      if (/^(hello|hi|hey|thank)/.test(s)) {
        const sentence = `${req.sentence.charAt(0).toUpperCase()}${req.sentence.slice(1)}${/[.!?]$/.test(req.sentence) ? '' : '.'}`
        return reading({ sentence, confidence: 0.95 })
      }
      if (s.includes('what') && s.includes('time')) {
        return reading({
          sentence: 'What time is my next meeting?',
          alternatives: ['Show my next meeting', 'What time is it?', 'Open Calendar'],
          confidence: 0.5
        })
      }
      if (s.includes('screenshot')) return reading({ sentence: 'Take a screenshot.', intent: 'Take a screenshot' })
      if (s.includes('email')) {
        return reading({ intent: 'Send this email to team@company.com', needs_confirmation: true })
      }
      return reading({
        sentence: 'Meeting tomorrow at 3pm.',
        intent: 'Schedule a meeting tomorrow at 3pm with the team',
        confidence: 0.86,
        needs_confirmation: true,
        context_actions: ['Insert text', 'Send message', 'More options']
      })
    },
    async spellSuggest(req) {
      await wait(300)
      const l = req.letters.toLowerCase()
      return { ok: true, value: [l, `${l}@calhacks.io`, `${l}.com`] }
    },
    async identifySign() {
      await wait(700)
      return { ok: true, value: MOCK_SIGN_GUESS }
    },
    signGuessUnavailable: () => null,
    sendsFrames: () => false,
    // No captions model in the mock: the captions keep the signs as signed.
    captionText: async () => ({ ok: false, error: 'No captions model in the mock' }),
    async agentRun(req) {
      const runId = `mock-${Date.now()}`
      const run = ++active
      const stopped = (): boolean => active !== run
      const task = req.intent.toLowerCase()
      void (async () => {
        emit({ type: 'started', runId, intent: req.intent })
        if (task.includes('screenshot')) {
          emit({ type: 'step', runId, step: { id: 's0', label: 'Taking screenshot', status: 'current' } })
          await wait(600)
          if (stopped()) return
          emit({ type: 'step', runId, step: { id: 's0', label: 'Taking screenshot', status: 'done' } })
          emit({
            type: 'done',
            runId,
            result: {
              title: 'Screenshot taken',
              subtitle: MOCK_SCREENSHOT_SUBTITLE,
              evidence: [{ tool: 'take_screenshot', args: {}, ok: true, result: `Saved a screenshot to ${MOCK_SCREENSHOT_PATH}.` }],
              view: { kind: 'openFile', path: MOCK_SCREENSHOT_PATH },
              reply: 'Saved a screenshot to your Desktop.'
            },
            complete: true
          })
          return
        }
        if (!/meeting|event|schedule|calendar|email/.test(task)) {
          // A message the agent answers in words: no tool runs.
          emit({ type: 'step', runId, step: { id: 'plan', label: 'Thinking', status: 'current' } })
          await wait(700)
          if (stopped()) return
          emit({
            type: 'done',
            runId,
            result: { title: 'Nothing was done', subtitle: "The agent didn't run any action", evidence: [], reply: mockReply(req.sentence) },
            complete: false
          })
          return
        }
        const steps = ['Opening Calendar', 'Creating event', 'Adding attendees', 'Adding meeting link']
        for (let i = 0; i < steps.length; i++) {
          if (stopped()) return
          emit({ type: 'step', runId, step: { id: `s${i}`, label: steps[i], status: 'current' } })
          await wait(700)
          if (stopped()) return
          if (i === 1) {
            const approved = await new Promise<boolean>((resolve) => {
              pendingConfirm = resolve
              emit({
                type: 'confirm',
                runId,
                requestId: `req-${runId}`,
                tool: 'calendar_create_event',
                details: {
                  kind: 'event',
                  title: 'Team Sync',
                  dateLabel: 'Tomorrow, Oct 25',
                  timeLabel: '10:00 – 11:00 AM',
                  guestsLabel: '4 guests',
                  videoLabel: 'Google Meet'
                }
              })
            })
            if (stopped()) return // agentStop() also rejects the pending confirmation
            if (!approved) {
              emit({ type: 'step', runId, step: { id: `s${i}`, label: steps[i], status: 'error' } })
              emit({
                type: 'done',
                runId,
                result: { title: 'Nothing was done', subtitle: 'You cancelled it', evidence: [] },
                complete: false
              })
              return
            }
          }
          emit({ type: 'step', runId, step: { id: `s${i}`, label: steps[i], status: 'done' } })
        }
        emit({
          type: 'done',
          runId,
          result: {
            title: 'Meeting created',
            subtitle: 'Tomorrow at 10:00 AM with 4 guests.',
            evidence: [{ tool: 'calendar_create_event', args: { title: 'Team Sync' }, ok: true, result: 'created' }],
            view: { kind: 'openApp', app: 'Calendar' },
            reply: 'Team Sync is on your calendar for tomorrow at 10.'
          },
          complete: true
        })
      })()
      return { ok: true, value: { runId } }
    },
    async agentStop() {
      active++
      pendingConfirm?.(false)
      pendingConfirm = null
      emit({ type: 'stopped', runId: 'mock' })
    },
    async agentRespond(_id, approved) {
      pendingConfirm?.(approved)
      pendingConfirm = null
    },
    onAgentEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async runShortcut(gestureId) {
      await wait(400)
      // The mock gesture whose task is a screenshot (tests and screenshot scenes use this id).
      if (gestureId === 'builtin-peace') {
        return {
          ok: true,
          title: 'Screenshot taken',
          subtitle: MOCK_SCREENSHOT_SUBTITLE,
          compiled: true,
          durationMs: 400,
          view: { kind: 'openFile', path: MOCK_SCREENSHOT_PATH }
        }
      }
      return { ok: true, title: 'Playing Motion Sickness', subtitle: 'Phoebe Bridgers', compiled: true, durationMs: 420 }
    },
    async frontmostApp() {
      return { name: 'Mail', windowTitle: 'New Message' }
    },
    async typeText() {
      return { ok: true, value: undefined }
    },
    async openTarget() {},
    async imageThumb() {
      return { ok: true, value: MOCK_SCREENSHOT_THUMB }
    }
  }
}
