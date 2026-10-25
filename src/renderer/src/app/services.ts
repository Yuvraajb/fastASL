import type {
  AgentEvent,
  ChatEvent,
  AgentRunRequest,
  FrontmostApp,
  InterpretRequest,
  IntentResult,
  Result,
  ShortcutRunResult,
  SpellRequest,
  ViewAction
} from '@shared/types'

/** Status lines of one LLM call while it runs, e.g. "Rate limited, retrying...". */
export type LlmStatusListener = (status: string) => void

/** What a call the card cancelled before it reached main answers. Nobody shows it. */
const CANCELLED = { ok: false as const, error: 'Cancelled' }

/** Everything the controller needs from the outside world. */
export interface Services {
  /** `onStatus` gets the call's progress lines; aborting `signal` cancels the call in main. */
  interpret(req: InterpretRequest, onStatus?: LlmStatusListener, signal?: AbortSignal): Promise<Result<IntentResult>>
  spellSuggest(req: SpellRequest, onStatus?: LlmStatusListener, signal?: AbortSignal): Promise<Result<string[]>>
  agentRun(req: AgentRunRequest): Promise<Result<{ runId: string }>>
  agentStop(): Promise<void>
  agentRespond(requestId: string, approved: boolean): Promise<void>
  onAgentEvent(cb: (event: AgentEvent) => void): () => void
  runShortcut(gestureId: string): Promise<ShortcutRunResult>
  /** Starts a chat reply; its text arrives through onChatEvent, tagged with `id`. */
  chatSend(id: string, text: string): Promise<Result<void>>
  chatStop(): Promise<void>
  chatReset(): Promise<void>
  onChatEvent(cb: (event: ChatEvent) => void): () => void
  frontmostApp(): Promise<FrontmostApp | null>
  typeText(text: string): Promise<Result<void>>
  openTarget(action: ViewAction): Promise<void>
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
    agentRun: (req) => api.agentRun(req),
    agentStop: () => api.agentStop(),
    agentRespond: (id, approved) => api.agentRespond(id, approved),
    onAgentEvent: (cb) => api.onAgentEvent(cb),
    runShortcut: (id) => api.runShortcut(id),
    chatSend: (id, text) => api.chatSend(id, text),
    chatStop: () => api.chatStop(),
    chatReset: () => api.chatReset(),
    onChatEvent: (cb) => api.onChatEvent(cb),
    frontmostApp: () => api.getFrontmostApp(),
    typeText: (text) => api.typeText(text),
    openTarget: (action) => api.openTarget(action)
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Mock services for UI work, screenshots and demos without keys. They script a
 * believable calendar flow so every state can be reached with the dev hotkeys.
 */
export function mockServices(): Services {
  const listeners = new Set<(e: AgentEvent) => void>()
  const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))
  const chatListeners = new Set<(e: ChatEvent) => void>()
  const chatEmit = (e: ChatEvent): void => chatListeners.forEach((l) => l(e))
  let chatRun = 0
  let chatId = ''
  let pendingConfirm: ((approved: boolean) => void) | null = null
  let stopped = false

  return {
    async interpret(req) {
      await wait(500)
      const s = req.sentence.toLowerCase()
      if (s.includes('what') && s.includes('time')) {
        return {
          ok: true,
          value: {
            sentence: 'What time is my next meeting?',
            intent: null,
            alternatives: ['Show my next meeting', 'What time is it?', 'Open Calendar'],
            confidence: 0.5,
            needs_confirmation: false,
            context_actions: []
          }
        }
      }
      if (s.includes('email')) {
        return {
          ok: true,
          value: {
            sentence: req.sentence,
            intent: 'Send this email to team@company.com',
            alternatives: [],
            confidence: 0.9,
            needs_confirmation: true,
            context_actions: ['Insert text', 'Send message', 'More options']
          }
        }
      }
      return {
        ok: true,
        value: {
          sentence: 'Meeting tomorrow at 3pm.',
          intent: 'Schedule a meeting tomorrow at 3pm with the team',
          alternatives: [],
          confidence: 0.86,
          needs_confirmation: true,
          context_actions: ['Insert text', 'Send message', 'More options']
        }
      }
    },
    async spellSuggest(req) {
      await wait(300)
      const l = req.letters.toLowerCase()
      return { ok: true, value: [l, `${l}@calhacks.io`, `${l}.com`] }
    },
    async agentRun(req) {
      const runId = `mock-${Date.now()}`
      stopped = false
      const said = req.intent
      const hasMeridiem = /\b(am|pm)\b/i.test(said)
      const bareHour = /\bmeeting\b\D*(\d{1,2})\b/i.exec(said)?.[1]
      const answered = /^(\d{1,2})\s*(am|pm)$/i.exec(said.trim())
      if (!answered && !hasMeridiem && bareHour) {
        // "meeting 1": the agent can't guess AM or PM, so it asks (the answer comes back as the next message).
        void (async () => {
          emit({ type: 'started', runId, intent: said })
          await wait(900)
          emit({ type: 'ask', runId, question: `${bareHour} AM or ${bareHour} PM?`, options: [`${bareHour} AM`, `${bareHour} PM`] })
          emit({ type: 'done', runId, result: { title: 'Question', subtitle: '', evidence: [] }, complete: false })
        })()
        return { ok: true, value: { runId } }
      }
      if (/\?\s*$|^(what|who|how|why|when|where|tell|hello|hi)\b/i.test(said.trim())) {
        void (async () => {
          emit({ type: 'started', runId, intent: said })
          await wait(900)
          emit({ type: 'text', runId, text: `Demo reply: you said "${said}". Add FACTORY_API_KEY to .env for a real answer.` })
          emit({ type: 'done', runId, result: { title: 'Answered', subtitle: '', evidence: [] }, complete: false })
        })()
        return { ok: true, value: { runId } }
      }
      const when = answered ? `${answered[1]}:00 ${answered[2].toUpperCase()}` : 'now'
      void (async () => {
        emit({ type: 'started', runId, intent: req.intent })
        const steps = ['Opening Calendar', 'Creating event', 'Adding attendees', 'Adding meeting link']
        for (let i = 0; i < steps.length; i++) {
          if (stopped) return
          emit({ type: 'step', runId, step: { id: `s${i}`, label: steps[i], status: 'current' } })
          await wait(700)
          if (stopped) return
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
                  title: answered ? 'Meeting' : 'Team Sync',
                  dateLabel: answered ? 'Today' : 'Tomorrow, Oct 25',
                  timeLabel: answered ? `${when} – 1 hour` : '10:00 – 11:00 AM',
                  ...(answered ? {} : { guestsLabel: '4 guests', videoLabel: 'Google Meet' })
                }
              })
            })
            if (stopped) return // agentStop() also rejects the pending confirmation
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
            subtitle: answered ? `Today at ${when}` : 'Tomorrow at 10:00 AM with 4 guests.',
            evidence: [{ tool: 'calendar_create_event', args: { title: 'Team Sync' }, ok: true, result: 'created' }],
            view: { kind: 'openApp', app: 'Calendar' }
          },
          complete: true
        })
      })()
      return { ok: true, value: { runId } }
    },
    async agentStop() {
      stopped = true
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
      if (gestureId === 'builtin-peace') {
        return { ok: true, title: 'Screenshot taken', subtitle: 'Saved to Desktop', compiled: true, durationMs: 400 }
      }
      return { ok: true, title: 'Playing Motion Sickness', subtitle: 'Phoebe Bridgers', compiled: true, durationMs: 420 }
    },
    async chatSend(id, text) {
      const run = ++chatRun
      chatId = id
      const reply = `You said: ${text}. (This is a demo reply: add FACTORY_API_KEY to .env for a real answer.)`
      void (async () => {
        for (const word of reply.split(/(?<= )/)) {
          await wait(35)
          if (run !== chatRun) return
          chatEmit({ type: 'delta', id, text: word })
        }
        chatEmit({ type: 'done', id })
      })()
      return { ok: true, value: undefined }
    },
    async chatStop() {
      chatRun++
      chatEmit({ type: 'done', id: chatId })
    },
    async chatReset() {
      chatRun++
    },
    onChatEvent(cb) {
      chatListeners.add(cb)
      return () => chatListeners.delete(cb)
    },
    async frontmostApp() {
      return { name: 'Mail', windowTitle: 'New Message' }
    },
    async typeText() {
      return { ok: true, value: undefined }
    },
    async openTarget() {}
  }
}
