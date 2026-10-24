import { describe, expect, it, vi } from 'vitest'
import { ToolConfirmationType } from '@factory/droid-sdk/node'
import type { AgentEvent } from '@shared/types'
import type { ToolDef } from '../tools/types'
import { MISSING_KEY_ERROR } from './agentService'
import { INSTALL_DROID } from './droidPath'
import {
  callTool,
  callTools,
  FakeSession,
  makeAgent,
  makeTools,
  reply,
  request,
  resultMessage,
  toolUse,
  type TurnScript
} from './testing/fakes'

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

async function startRun(ctx: ReturnType<typeof makeAgent>, intent = 'do it') {
  const started = await ctx.agent.start(request(intent), ctx.emit)
  if (!started.ok) throw new Error(started.error)
  return started.value
}

async function waitForConfirm(events: AgentEvent[], index = 0) {
  return vi.waitFor(() => {
    const confirm = ofType(events, 'confirm')[index]
    if (!confirm) throw new Error('no confirm yet')
    return confirm
  })
}

describe('AgentService', () => {
  it('auto-approves read tools and builds Done from the tool outcome, not the model text', async () => {
    const ctx = makeAgent([callTool('take_screenshot', {}, 'I emailed your boss!')])
    const { runId, completion } = await startRun(ctx, 'Take a screenshot')
    const outcome = await completion

    expect(ofType(ctx.events, 'confirm')).toHaveLength(0)
    expect(ctx.runs).toEqual(['take_screenshot'])
    expect(ctx.events[0]).toEqual({ type: 'started', runId, intent: 'Take a screenshot' })
    expect(ofType(ctx.events, 'step').map((e) => [e.step.label, e.step.status])).toEqual([
      ['Thinking', 'current'],
      ['Thinking', 'done'],
      ['Taking screenshot', 'current'],
      ['Taking screenshot', 'done']
    ])
    const done = ofType(ctx.events, 'done')[0]
    expect(done.result).toMatchObject({ title: 'Screenshot saved', subtitle: 'Desktop' })
    expect(done.complete).toBe(true)
    expect(done.result.evidence).toEqual([
      { tool: 'take_screenshot', args: {}, ok: true, result: 'Saved Screenshot.png to Desktop' }
    ])
    expect(outcome.kind).toBe('done')
    expect(ctx.recent).toEqual([{ intent: 'Take a screenshot', title: 'Screenshot saved', at: Date.parse('2026-10-24T22:45:00Z'), evidence: done.result.evidence }])
    expect(ctx.agent.lastRunCalls().map((c) => c.tool)).toEqual(['take_screenshot'])
  })

  it('run() returns the run id and puts date, time zone and frontmost app in the turn prompt', async () => {
    const ctx = makeAgent([reply('ok')])
    const result = await ctx.agent.run(request('Remind me tomorrow'), ctx.emit)
    expect(result.ok && result.value.runId).toBe(ofType(ctx.events, 'started')[0].runId)
    await vi.waitFor(() => expect(ofType(ctx.events, 'done')).toHaveLength(1))
    const prompt = ctx.sessions[0].prompts[0]
    expect(prompt).toContain('Saturday, October 24, 2026')
    expect(prompt).toContain('America/Los_Angeles')
    expect(prompt).toContain('Frontmost app: Messages')
    expect(prompt).toContain('Task: Remind me tomorrow')
  })

  it('asks before a write tool and runs it once approved', async () => {
    const ctx = makeAgent([callTool('send_message', { to: 'Mom', text: 'On my way' })])
    const { runId, completion } = await startRun(ctx)

    const confirm = await waitForConfirm(ctx.events)
    expect(confirm).toMatchObject({ runId, tool: 'send_message', details: { kind: 'message', to: 'Mom', text: 'On my way' } })
    expect(ctx.runs).toEqual([])

    await ctx.agent.respond(confirm.requestId, true)
    await completion
    expect(ctx.runs).toEqual(['send_message'])
    expect(ofType(ctx.events, 'done')[0].result).toMatchObject({ title: 'Message sent', subtitle: 'To Mom' })
  })

  it('cancels a write tool the user declines', async () => {
    const ctx = makeAgent([callTool('send_message', { to: 'Mom', text: 'hi' })])
    const { completion } = await startRun(ctx)
    await ctx.agent.respond((await waitForConfirm(ctx.events)).requestId, false)
    await completion

    expect(ctx.runs).toEqual([])
    expect(ofType(ctx.events, 'done')[0].result).toMatchObject({ title: 'Nothing was done', subtitle: 'You cancelled it' })
    expect(ctx.recent).toEqual([])
  })

  it('does not count a task as done when the user declines its write after a lookup', async () => {
    const ctx = makeAgent([callTools([['take_screenshot', {}], ['send_message', { to: 'Mom', text: 'hi' }]])])
    const { completion } = await startRun(ctx)
    await ctx.agent.respond((await waitForConfirm(ctx.events)).requestId, false)

    expect(await completion).toMatchObject({ kind: 'done', complete: false })
    expect(ofType(ctx.events, 'done')[0]).toMatchObject({ complete: false, result: { title: 'Nothing was done', subtitle: 'You cancelled it' } })
    expect(ctx.recent).toEqual([])
    expect(ctx.agent.lastRunCalls()).toEqual([])
  })

  it('leaves no approval behind when only part of a permission request is confirmed', async () => {
    const seen: unknown[] = []
    const batch: TurnScript = async function* (session) {
      seen.push(await session.requestPermission([toolUse('send_message', { to: 'Ann', text: '1' }), toolUse('send_message', { to: 'Bob', text: '2' })]))
      seen.push(await session.runHandler('send_message', { to: 'Boss', text: 'I quit' }))
      yield resultMessage('interrupted')
    }
    const ctx = makeAgent([batch])
    const { completion } = await startRun(ctx)
    await ctx.agent.respond((await waitForConfirm(ctx.events, 0)).requestId, true)
    await ctx.agent.respond((await waitForConfirm(ctx.events, 1)).requestId, false)
    await completion

    expect(seen).toEqual(['cancelled', { content: [{ type: 'text', text: 'The user has not confirmed this action.' }], isError: true }])
    expect(ctx.runs).toEqual([])
  })

  it('stop() during a confirm cancels it, interrupts the turn and keeps the session', async () => {
    const ctx = makeAgent([callTool('send_message', { to: 'Mom', text: 'hi' }), callTool('take_screenshot')])
    const first = await startRun(ctx)
    await waitForConfirm(ctx.events)

    await ctx.agent.stop()
    expect(await first.completion).toEqual({ kind: 'stopped' })
    expect(ctx.events.at(-1)).toEqual({ type: 'stopped', runId: first.runId })
    expect(ctx.sessions[0].interrupts).toBe(1)
    expect(ctx.runs).toEqual([])
    expect(ofType(ctx.events, 'done')).toHaveLength(0)

    const second = await startRun(ctx)
    expect((await second.completion).kind).toBe('done')
    expect(ctx.sessions).toHaveLength(1)
    expect(ctx.runs).toEqual(['take_screenshot'])
  })

  it('stop() while a write is running: Done reports the write once it lands', async () => {
    let land: () => void = () => {}
    const slowSend = async (def: ToolDef, args: Record<string, unknown>) => {
      await new Promise<void>((resolve) => (land = resolve))
      return def.run(args)
    }
    const tools = makeTools().tools.map((def) =>
      def.name === 'send_message' ? { ...def, run: (args: Record<string, unknown>) => slowSend(def, args) } : def
    )
    // Like droid: an interrupt ends the turn without waiting for the tool.
    const sending: TurnScript = async function* (session) {
      void session.callTool('send_message', { to: 'Mom', text: 'On my way' })
      await vi.waitFor(() => expect(session.interrupts).toBe(1))
      yield resultMessage('interrupted')
    }
    const ctx = makeAgent([sending], { tools })
    const { runId, completion } = await startRun(ctx)
    await ctx.agent.respond((await waitForConfirm(ctx.events)).requestId, true)
    await vi.waitFor(() => expect(ofType(ctx.events, 'step').at(-1)?.step).toMatchObject({ label: 'Messaging Mom', status: 'current' }))

    await ctx.agent.stop()
    expect(await completion).toEqual({ kind: 'stopped' })
    expect(ctx.events.at(-1)).toEqual({ type: 'stopped', runId })

    land()
    await vi.waitFor(() => expect(ofType(ctx.events, 'done')).toHaveLength(1))
    expect(ofType(ctx.events, 'done')[0]).toMatchObject({
      runId,
      complete: false,
      result: { title: 'Message sent', subtitle: 'You stopped the rest' }
    })
    expect(ofType(ctx.events, 'step').filter((e) => e.step.status !== 'current')).toHaveLength(1) // just Thinking
    expect(ctx.recent).toEqual([])
  })

  it('stops the active run before starting a new one', async () => {
    const ctx = makeAgent([callTool('send_message', { to: 'Mom', text: 'hi' }), reply('ok')])
    const first = await startRun(ctx)
    await waitForConfirm(ctx.events)
    const second = await startRun(ctx)

    expect(await first.completion).toEqual({ kind: 'stopped' })
    expect(ofType(ctx.events, 'stopped')).toEqual([{ type: 'stopped', runId: first.runId }])
    expect((await second.completion).kind).toBe('done')
  })

  it('says nothing was done when the model only talks', async () => {
    const ctx = makeAgent([reply('Your meeting is booked!')])
    await (await startRun(ctx)).completion
    expect(ofType(ctx.events, 'done')[0].result).toEqual({
      title: 'Nothing was done',
      subtitle: "The agent didn't run any action",
      evidence: []
    })
  })

  it('derives the reason from a failed tool', async () => {
    const ctx = makeAgent([callTool('read_calendar')])
    await (await startRun(ctx)).completion
    const { result } = ofType(ctx.events, 'done')[0]
    expect(result).toMatchObject({ title: 'Nothing was done', subtitle: 'Calendar access was denied' })
    expect(result.evidence).toEqual([{ tool: 'read_calendar', args: {}, ok: false, result: 'Calendar access was denied' }])
  })

  it('cancels tools that are not from the fastasl server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const decisions: unknown[] = []
    const foreign: TurnScript = async function* (session) {
      const execute = {
        ...toolUse('Execute', { command: 'rm -rf ~' }),
        details: { type: ToolConfirmationType.Execute, command: 'rm -rf ~', fullCommand: 'rm -rf ~' }
      } as const
      decisions.push(await session.callTool('take_screenshot', {}, execute))
      decisions.push(await session.callTool('take_screenshot', {}, toolUse('take_screenshot', {}, 'other-server')))
      yield resultMessage('interrupted')
    }
    const ctx = makeAgent([foreign])
    await (await startRun(ctx)).completion
    expect(decisions).toEqual(['cancelled', 'cancelled'])
    expect(ctx.runs).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('refuses a write tool that reaches the handler without the user approving it', async () => {
    const results: unknown[] = []
    const sneaky: TurnScript = async function* (session) {
      results.push(await session.runHandler('send_message', { to: 'Boss', text: 'I quit' }))
      yield resultMessage('success')
    }
    const ctx = makeAgent([sneaky])
    await (await startRun(ctx)).completion
    expect(results).toEqual([{ content: [{ type: 'text', text: 'The user has not confirmed this action.' }], isError: true }])
    expect(ctx.runs).toEqual([])
  })

  it('emits an error when the turn fails before any tool ran', async () => {
    const failing: TurnScript = async function* () {
      yield resultMessage('error_during_execution', 'Out of credits')
    }
    const ctx = makeAgent([failing])
    const { runId, completion } = await startRun(ctx)
    expect(await completion).toEqual({ kind: 'failed', message: 'Out of credits' })
    expect(ofType(ctx.events, 'error')).toEqual([{ type: 'error', runId, message: 'Out of credits' }])
  })

  it('replaces a dead session and retries the turn once', async () => {
    const dead: TurnScript = async function* () {
      throw new Error('Droid process exited')
    }
    const ctx = makeAgent([dead, callTool('take_screenshot')])
    const { completion } = await startRun(ctx)
    expect((await completion).kind).toBe('done')
    expect(ctx.sessions).toHaveLength(2)
    expect(ctx.sessions[0].closed).toBe(true)
  })

  it('reports a write that ran before droid died as done, and does not retry the turn', async () => {
    const diesAfterSending: TurnScript = async function* (session) {
      await session.callTool('send_message', { to: 'Mom', text: 'hi' })
      throw new Error('Droid process exited')
    }
    const ctx = makeAgent([diesAfterSending, callTool('send_message', { to: 'Mom', text: 'hi' })])
    const { completion } = await startRun(ctx)
    await ctx.agent.respond((await waitForConfirm(ctx.events)).requestId, true)

    expect(await completion).toMatchObject({ kind: 'done', complete: false })
    expect(ofType(ctx.events, 'error')).toEqual([])
    expect(ofType(ctx.events, 'done')[0]).toMatchObject({ complete: false, result: { title: 'Message sent', subtitle: 'Droid process exited' } })
    expect(ctx.runs).toEqual(['send_message'])
    expect(ctx.sessions).toHaveLength(1)
    expect(ctx.recent).toEqual([])
  })

  it('reports a missing FACTORY_API_KEY without starting droid', async () => {
    const droidPath = vi.fn()
    const ctx = makeAgent([], { apiKey: () => undefined, droidPath })
    expect(await ctx.agent.run(request('x'), ctx.emit)).toEqual({ ok: false, error: MISSING_KEY_ERROR, missingKey: 'FACTORY_API_KEY' })
    expect(droidPath).not.toHaveBeenCalled()
    expect(ctx.sessions).toHaveLength(0)
    expect(ctx.events).toEqual([])
  })

  it('reports a missing droid CLI', async () => {
    const ctx = makeAgent([], { droidPath: async () => ({ ok: false, error: INSTALL_DROID }) })
    expect(await ctx.agent.run(request('x'), ctx.emit)).toEqual({ ok: false, error: INSTALL_DROID })
    expect(ctx.sessions).toHaveLength(0)
  })

  it('reports a session that fails to start instead of throwing', async () => {
    const ctx = makeAgent([], { openSession: () => Promise.reject(new Error('protocol mismatch')) })
    expect(await ctx.agent.run(request('x'), ctx.emit)).toEqual({ ok: false, error: "Couldn't start the agent: protocol mismatch" })
  })

  it('dispose() closes the session', async () => {
    const ctx = makeAgent([reply('ok')])
    ctx.agent.init()
    await vi.waitFor(() => expect(ctx.sessions).toHaveLength(1))
    await ctx.agent.dispose()
    expect(ctx.sessions[0].closed).toBe(true)
  })

  it('dispose() during a cold start: the queued run stops, and no droid starts after it', async () => {
    const opened: FakeSession[] = []
    let spawned: () => void = () => {}
    const spawning = new Promise<void>((resolve) => (spawned = resolve))
    const ctx = makeAgent([], {
      openSession: async (options) => {
        await spawning
        const session = new FakeSession(options, [callTool('take_screenshot')])
        opened.push(session)
        return session
      }
    })
    ctx.agent.init()
    const queued = ctx.agent.start(request('Take a screenshot'), ctx.emit)
    const disposed = ctx.agent.dispose()
    spawned()
    await disposed

    expect(await queued).toEqual({ ok: false, error: 'Stopped' })
    expect(await ctx.agent.run(request('x'), ctx.emit)).toEqual({ ok: false, error: 'Stopped' })
    expect(await ctx.agent.replay('x', [{ tool: 'take_screenshot', args: {}, ok: true }], ctx.emit)).toEqual({ kind: 'stopped' })
    expect(opened).toHaveLength(1)
    expect(opened[0].closed).toBe(true)
    expect(ctx.events).toEqual([])
    expect(ctx.runs).toEqual([])
  })
})
