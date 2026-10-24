import type {
  AgentEvent,
  AgentRunRequest,
  FrontmostApp,
  InterpretRequest,
  IntentResult,
  Result,
  ShortcutRunResult,
  SpellRequest,
  ViewAction
} from '@shared/types'

/** Everything the controller needs from the outside world. */
export interface Services {
  interpret(req: InterpretRequest): Promise<Result<IntentResult>>
  spellSuggest(req: SpellRequest): Promise<Result<string[]>>
  agentRun(req: AgentRunRequest): Promise<Result<{ runId: string }>>
  agentStop(): Promise<void>
  agentRespond(requestId: string, approved: boolean): Promise<void>
  onAgentEvent(cb: (event: AgentEvent) => void): () => void
  runShortcut(gestureId: string): Promise<ShortcutRunResult>
  frontmostApp(): Promise<FrontmostApp | null>
  typeText(text: string): Promise<Result<void>>
  openTarget(action: ViewAction): Promise<void>
}

/** Real services: everything goes through the preload bridge to the main process. */
export function ipcServices(): Services {
  const api = window.fastasl
  return {
    interpret: (req) => api.interpret(req),
    spellSuggest: (req) => api.spellSuggest(req),
    agentRun: (req) => api.agentRun(req),
    agentStop: () => api.agentStop(),
    agentRespond: (id, approved) => api.agentRespond(id, approved),
    onAgentEvent: (cb) => api.onAgentEvent(cb),
    runShortcut: (id) => api.runShortcut(id),
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
                  title: 'Team Sync',
                  dateLabel: 'Tomorrow, Oct 25',
                  timeLabel: '10:00 – 11:00 AM',
                  guestsLabel: '4 guests',
                  videoLabel: 'Google Meet'
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
            subtitle: 'Tomorrow at 10:00 AM with 4 guests.',
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
    async frontmostApp() {
      return { name: 'Mail', windowTitle: 'New Message' }
    },
    async typeText() {
      return { ok: true, value: undefined }
    },
    async openTarget() {}
  }
}
