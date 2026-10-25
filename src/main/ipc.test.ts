import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { AgentEvent, CustomGesture } from '@shared/types'
import { runShortcut } from './agent/shortcuts'
import { callTool, makeAgent, SCREENSHOT } from './agent/testing/fakes'
import { registerIpc, type MainServices } from './ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  windows: [] as { isDestroyed(): boolean; webContents: { send(channel: string, event: AgentEvent): void } }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => electron.listeners.set(channel, fn)
  },
  BrowserWindow: { getAllWindows: () => electron.windows },
  shell: {}
}))

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(electron.handlers.get(channel)?.({}, ...args))

/** A live overlay and a closed window: agent events must reach only the live one. */
function windows() {
  const received: AgentEvent[] = []
  const send = vi.fn((channel: string, event: AgentEvent) => {
    if (channel === IPC.agentEvent) received.push(event)
  })
  const closed = vi.fn()
  electron.windows.splice(0, electron.windows.length, { isDestroyed: () => false, webContents: { send } }, {
    isDestroyed: () => true,
    webContents: { send: closed }
  })
  return { received, closed }
}

/** The agent services as src/main/index.ts plugs them in, on a scripted Droid session. */
function agentServices(ctx: ReturnType<typeof makeAgent>, gestures: CustomGesture[] = []): MainServices {
  return {
    agentRun: (req, emit) => ctx.agent.run(req, emit),
    agentStop: () => ctx.agent.stop(),
    agentRespond: (requestId, approved) => ctx.agent.respond(requestId, approved),
    runShortcut: (gestureId, emit) =>
      runShortcut(gestureId, emit, { agent: ctx.agent, getGestures: () => gestures, saveGestures: () => undefined })
  }
}

const request = { intent: 'Text Mom hi', sentence: 'Text mom hi', frontmost: null }

beforeEach(() => electron.handlers.clear())

describe('agent IPC', () => {
  it('runs the agent and broadcasts every event to live windows: steps, confirm, done', async () => {
    const { received, closed } = windows()
    const ctx = makeAgent([callTool('send_message', { to: 'Mom', text: 'hi' })])
    registerIpc(() => null, agentServices(ctx))

    const started = (await invoke(IPC.agentRun, request)) as { ok: true; value: { runId: string } }
    expect(started.ok).toBe(true)
    const { runId } = started.value
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe('confirm'))
    const confirm = received.at(-1) as Extract<AgentEvent, { type: 'confirm' }>
    expect(confirm).toMatchObject({ runId, tool: 'send_message', details: { kind: 'message', to: 'Mom', text: 'hi' } })

    await invoke(IPC.agentRespond, confirm.requestId, true)
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe('done'))
    expect(received.map((e) => e.type)).toEqual(['started', 'step', 'confirm', 'step', 'step', 'step', 'done'])
    expect(received.every((e) => e.runId === runId)).toBe(true)
    expect(received.at(-1)).toMatchObject({ complete: true, result: { title: 'Message sent', subtitle: 'To Mom' } })
    expect(ctx.runs).toEqual(['send_message'])
    expect(closed).not.toHaveBeenCalled()
  })

  it('a stop while the Confirm card is up sends "stopped" and nothing runs', async () => {
    const { received } = windows()
    const ctx = makeAgent([callTool('send_message', { to: 'Mom', text: 'hi' })])
    registerIpc(() => null, agentServices(ctx))

    await invoke(IPC.agentRun, request)
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe('confirm'))
    await invoke(IPC.agentStop)
    expect(received.at(-1)?.type).toBe('stopped')
    expect(ctx.runs).toEqual([])
  })

  it('reports a missing FACTORY_API_KEY from agentRun, with no events', async () => {
    const { received } = windows()
    const ctx = makeAgent([], { apiKey: () => undefined })
    registerIpc(() => null, agentServices(ctx))

    expect(await invoke(IPC.agentRun, request)).toEqual({
      ok: false,
      error: 'Add FACTORY_API_KEY to .env',
      missingKey: 'FACTORY_API_KEY'
    })
    expect(received).toEqual([])
  })

  it('replays a compiled read-only shortcut silently and returns its result', async () => {
    const { received } = windows()
    const ctx = makeAgent([])
    const peace: CustomGesture = {
      id: 'builtin-peace',
      name: 'Peace sign',
      task: 'Take a screenshot',
      shape: [],
      compiled: [{ tool: 'take_screenshot', args: {}, ok: true }],
      builtin: true,
      createdAt: 0
    }
    registerIpc(() => null, agentServices(ctx, [peace]))

    expect(await invoke(IPC.runShortcut, 'builtin-peace')).toMatchObject({
      ok: true,
      title: 'Screenshot saved',
      subtitle: 'Desktop',
      compiled: true,
      view: { kind: 'openFile', path: SCREENSHOT }
    })
    expect(received).toEqual([])
    expect(ctx.sessions).toEqual([])
  })

  it('answers softly when the agent is not plugged in (screenshots, mock services)', async () => {
    windows()
    registerIpc(() => null, {})
    expect(await invoke(IPC.agentRun, request)).toEqual({ ok: false, error: 'The agent is not available yet' })
    expect(await invoke(IPC.runShortcut, 'builtin-peace')).toMatchObject({ ok: false, title: 'Shortcut unavailable' })
    expect(await invoke(IPC.agentStop)).toBeUndefined()
  })
})

describe('LLM status IPC', () => {
  const req = { tokens: ['HI'], sentence: 'hi', mode: 'command' as const, frontmost: null, gestures: [] }
  const intent = { sentence: 'Hi.', intent: null, alternatives: [], confidence: 1, needs_confirmation: false, context_actions: [] }

  /** Every event sent to the one live window. */
  function liveWindow() {
    const sent: { channel: string; event: unknown }[] = []
    electron.windows.splice(0, electron.windows.length, {
      isDestroyed: () => false,
      webContents: { send: (channel: string, event: unknown) => void sent.push({ channel, event }) }
    } as (typeof electron.windows)[number])
    return sent
  }

  it("tags a call's status lines with the renderer's call id", async () => {
    const sent = liveWindow()
    registerIpc(() => null, {
      interpret: async (_req, onStatus) => {
        onStatus?.('Rate limited, retrying...')
        return { ok: true, value: intent }
      },
      spellSuggest: async (_req, onStatus) => {
        onStatus?.('Rate limited, retrying...')
        return { ok: true, value: [] }
      }
    })

    expect(await invoke(IPC.interpret, req, 'abc-1')).toEqual({ ok: true, value: intent })
    await invoke(IPC.spellSuggest, { letters: 'KR', frontmost: null }, 'abc-2')
    expect(sent).toEqual([
      { channel: IPC.llmStatus, event: { callId: 'abc-1', status: 'Rate limited, retrying...' } },
      { channel: IPC.llmStatus, event: { callId: 'abc-2', status: 'Rate limited, retrying...' } }
    ])
  })

  it('gives a call without an id no status listener and no cancel signal', async () => {
    liveWindow()
    const args: unknown[] = []
    registerIpc(() => null, {
      interpret: async (_req, onStatus, signal) => {
        args.push(onStatus, signal)
        return { ok: true, value: intent }
      }
    })
    await invoke(IPC.interpret, req)
    expect(args).toEqual([undefined, undefined])
  })

  it('aborts the call the renderer cancels, and only that one', async () => {
    liveWindow()
    const signals: AbortSignal[] = []
    const answers: (() => void)[] = []
    registerIpc(() => null, {
      interpret: (_req, _onStatus, signal) => {
        signals.push(signal!)
        return new Promise((resolve) => answers.push(() => resolve({ ok: true, value: intent })))
      },
      spellSuggest: (_req, _onStatus, signal) => {
        signals.push(signal!)
        return new Promise((resolve) => answers.push(() => resolve({ ok: true, value: [] })))
      }
    })
    const cancel = (callId: unknown): void => electron.listeners.get(IPC.llmCancel)?.({}, callId)

    const a = invoke(IPC.interpret, req, 'w-1')
    const b = invoke(IPC.spellSuggest, { letters: 'KR', frontmost: null }, 'w-2')
    cancel('w-1')
    cancel('nobody')
    cancel(42)
    expect(signals.map((s) => s.aborted)).toEqual([true, false])

    answers.forEach((answer) => answer())
    await Promise.all([a, b])
    cancel('w-2') // settled: nothing left to abort
    expect(signals[1].aborted).toBe(false)
  })

  it('identifySign: tags status lines, can be cancelled, and refuses a malformed request before any provider sees it', async () => {
    const sent = liveWindow()
    const signals: AbortSignal[] = []
    const answers: (() => void)[] = []
    const guess = { is_sign: true, candidates: [{ gloss: 'HELLO', confidence: 0.6, hands: 1 as const }] }
    const identifySign = vi.fn((_req: unknown, onStatus?: (s: string) => void, signal?: AbortSignal) => {
      onStatus?.('Rate limited, retrying...')
      signals.push(signal!)
      return new Promise<{ ok: true; value: typeof guess }>((resolve) => answers.push(() => resolve({ ok: true, value: guess })))
    })
    registerIpc(() => null, { identifySign })
    const sign = { frames: ['/9j/AAA='], motion: '1 s', mode: 'command', known: ['YES'] }

    const a = invoke(IPC.identifySign, sign, 's-1')
    const b = invoke(IPC.identifySign, sign, 's-2')
    electron.listeners.get(IPC.llmCancel)?.({}, 's-1')
    expect(signals.map((x) => x.aborted)).toEqual([true, false])
    answers.forEach((answer) => answer())
    expect(await b).toEqual({ ok: true, value: guess })
    await a
    expect(sent).toContainEqual({ channel: IPC.llmStatus, event: { callId: 's-1', status: 'Rate limited, retrying...' } })

    const tooMany = { ...sign, frames: Array.from({ length: 9 }, () => '/9j/AAA=') }
    const bads = [
      null,
      { ...sign, frames: 'x' },
      tooMany,
      { ...sign, mode: 'shout' },
      { ...sign, known: [1] },
      { ...sign, motion: 'x'.repeat(2001) },
      { ...sign, known: Array.from({ length: 501 }, () => 'YES') },
      { ...sign, known: ['Y'.repeat(65)] }
    ]
    for (const bad of bads) {
      expect(await invoke(IPC.identifySign, bad, 's-3')).toEqual({ ok: false, error: 'Bad sign request' })
    }
    expect(identifySign).toHaveBeenCalledTimes(2)
  })

  it('identifySign without the service answers softly', async () => {
    registerIpc(() => null, {})
    expect(await invoke(IPC.identifySign, { frames: [], motion: '', mode: 'command', known: [] })).toEqual({
      ok: false,
      error: 'Sign guessing is not available yet'
    })
  })
})

describe('screenshot thumbnail IPC', () => {
  it('hands the path to imageThumb, which decides (main/thumbs.ts refuses files fastASL did not take)', async () => {
    const imageThumb = vi.fn((path: unknown) =>
      path === SCREENSHOT ? { ok: true as const, value: 'data:image/png;base64,AAAA' } : { ok: false as const, error: 'Not a screenshot fastASL took' }
    )
    registerIpc(() => null, { imageThumb })
    expect(await invoke(IPC.imageThumb, SCREENSHOT)).toEqual({ ok: true, value: 'data:image/png;base64,AAAA' })
    expect(await invoke(IPC.imageThumb, '/Users/me/Documents/passport.png')).toEqual({ ok: false, error: 'Not a screenshot fastASL took' })
    expect(imageThumb).toHaveBeenCalledTimes(2)
  })

  it('answers softly without the service', async () => {
    registerIpc(() => null, {})
    expect(await invoke(IPC.imageThumb, SCREENSHOT)).toEqual({ ok: false, error: 'Thumbnails is not available yet' })
  })
})
