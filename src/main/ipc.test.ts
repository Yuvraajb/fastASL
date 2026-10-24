import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { AgentEvent, CustomGesture } from '@shared/types'
import { runShortcut } from './agent/shortcuts'
import { callTool, makeAgent } from './agent/testing/fakes'
import { registerIpc, type MainServices } from './ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  windows: [] as { isDestroyed(): boolean; webContents: { send(channel: string, event: AgentEvent): void } }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, fn),
    on: () => undefined
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
      compiled: true
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
