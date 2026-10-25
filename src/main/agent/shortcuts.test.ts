import { describe, expect, it, vi } from 'vitest'
import type { CustomGesture } from '@shared/types'
import type { ToolOutcome } from '../tools/types'
import { runShortcut } from './shortcuts'
import { callTool, callTools, makeAgent, reply, request, SCREENSHOT, type TurnScript } from './testing/fakes'

const PEACE: CustomGesture = {
  id: 'builtin-peace',
  name: 'Peace sign',
  task: 'Take a screenshot',
  shape: [],
  compiled: [{ tool: 'take_screenshot', args: {}, ok: true }],
  builtin: true,
  createdAt: 0
}

/** A gesture whose compiled step is the (slow, controllable) read_calendar tool. */
const CALENDAR: CustomGesture = { ...PEACE, id: 'g-cal', builtin: false, task: 'Show my calendar', compiled: [{ tool: 'read_calendar', args: {}, ok: true }] }

/** A runTool that waits until released, like a slow AppleScript step. */
function gatedTool(outcome: ToolOutcome) {
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const runTool = vi.fn(async () => {
    await gate
    return outcome
  })
  return { runTool, release }
}

function setup(gestures: CustomGesture[], turns: TurnScript[] = [], agentOverrides = {}) {
  const ctx = makeAgent(turns, agentOverrides)
  let saved = gestures
  const saveGestures = vi.fn((list: CustomGesture[]) => {
    saved = list
  })
  const run = (id: string) => runShortcut(id, ctx.emit, { agent: ctx.agent, getGestures: () => saved, saveGestures })
  return { ...ctx, run, saveGestures, saved: () => saved }
}

describe('runShortcut', () => {
  it('replays the built-in peace sign with no model and no keys', async () => {
    const openSession = vi.fn()
    const ctx = setup([PEACE], [], { apiKey: () => undefined, openSession })
    const result = await ctx.run('builtin-peace')

    // The toast gets the file to show and open (the card asks main for its thumbnail).
    expect(result).toEqual({
      ok: true,
      title: 'Screenshot saved',
      subtitle: 'Desktop',
      compiled: true,
      durationMs: expect.any(Number),
      view: { kind: 'openFile', path: SCREENSHOT }
    })
    expect(result.durationMs).toBeLessThan(500)
    expect(ctx.runs).toEqual(['take_screenshot'])
    expect(openSession).not.toHaveBeenCalled()
    expect(ctx.events).toEqual([])
    expect(ctx.saveGestures).not.toHaveBeenCalled()
  })

  it('still confirms write steps of a compiled sequence', async () => {
    const gesture: CustomGesture = {
      ...PEACE,
      id: 'g-mom',
      task: 'Text Mom on my way',
      builtin: false,
      compiled: [{ tool: 'send_message', args: { to: 'Mom', text: 'On my way' }, ok: true }]
    }
    const ctx = setup([gesture])
    const pending = ctx.run('g-mom')

    const confirm = await vi.waitFor(() => {
      const event = ctx.events.find((e) => e.type === 'confirm')
      if (event?.type !== 'confirm') throw new Error('no confirm yet')
      return event
    })
    expect(confirm.details).toEqual({ kind: 'message', to: 'Mom', text: 'On my way' })
    expect(ctx.runs).toEqual([])
    await ctx.agent.respond(confirm.requestId, true)

    expect(await pending).toMatchObject({ ok: true, title: 'Message sent', compiled: true })
    expect(ctx.events.map((e) => e.type)).toEqual(['started', 'confirm', 'step', 'step', 'done'])
  })

  it('falls back to the agent when a replay step fails, then re-records the sequence', async () => {
    const gesture: CustomGesture = { ...PEACE, id: 'g-1', builtin: false, compiled: [{ tool: 'read_calendar', args: {}, ok: true }] }
    const ctx = setup([gesture], [callTool('take_screenshot')])
    const result = await ctx.run('g-1')

    expect(result).toMatchObject({ ok: true, title: 'Screenshot saved', compiled: false })
    expect(ctx.runs).toEqual(['read_calendar', 'take_screenshot'])
    expect(ctx.events[0]).toMatchObject({ type: 'started', intent: 'Take a screenshot' })
    expect(ctx.saved()[0].compiled).toEqual([
      { tool: 'take_screenshot', args: {}, ok: true, result: 'Saved Screenshot.png to Desktop' }
    ])
  })

  it('compiles a new gesture on its first successful agent run', async () => {
    const gesture: CustomGesture = { ...PEACE, id: 'g-2', builtin: false, compiled: undefined }
    const ctx = setup([PEACE, gesture], [callTool('take_screenshot')])
    expect(await ctx.run('g-2')).toMatchObject({ ok: true, compiled: false })
    expect(ctx.saved()[0]).toBe(PEACE)
    expect(ctx.saved()[1].compiled?.map((c) => c.tool)).toEqual(['take_screenshot'])
  })

  it('does not record a sequence when the agent did nothing', async () => {
    const gesture: CustomGesture = { ...PEACE, id: 'g-3', builtin: false, compiled: undefined }
    const ctx = setup([gesture], [callTool('read_calendar')])
    expect(await ctx.run('g-3')).toMatchObject({ ok: false, title: 'Nothing was done', subtitle: 'Calendar access was denied' })
    expect(ctx.saveGestures).not.toHaveBeenCalled()
  })

  it('neither compiles nor reports success when the user declines the write after a lookup', async () => {
    const gesture: CustomGesture = { ...PEACE, id: 'g-5', builtin: false, task: 'Text Mom hi', compiled: undefined }
    const ctx = setup([gesture], [callTools([['take_screenshot', {}], ['send_message', { to: 'Mom', text: 'hi' }]])])
    const pending = ctx.run('g-5')
    const confirm = await vi.waitFor(() => {
      const event = ctx.events.find((e) => e.type === 'confirm')
      if (event?.type !== 'confirm') throw new Error('no confirm yet')
      return event
    })
    await ctx.agent.respond(confirm.requestId, false)

    expect(await pending).toMatchObject({ ok: false, title: 'Nothing was done', subtitle: 'You cancelled it' })
    expect(ctx.saveGestures).not.toHaveBeenCalled()
    expect(ctx.recent).toEqual([])
  })

  it('does not compile a run whose last step failed', async () => {
    const gesture: CustomGesture = { ...PEACE, id: 'g-6', builtin: false, task: 'Play Motion Sickness', compiled: undefined }
    const ctx = setup([gesture], [callTools([['take_screenshot', {}], ['read_calendar', {}]])])
    expect(await ctx.run('g-6')).toMatchObject({ ok: false, title: 'Screenshot saved', subtitle: 'Calendar access was denied' })
    expect(ctx.saveGestures).not.toHaveBeenCalled()
  })

  it('never falls back to the agent once a replay was stopped', async () => {
    const slow = gatedTool({ ok: false, text: 'Spotify did not start playing' })
    const ctx = setup([CALENDAR], [callTool('take_screenshot')], { runTool: slow.runTool })
    const pending = ctx.run('g-cal')
    await vi.waitFor(() => expect(slow.runTool).toHaveBeenCalled())
    await ctx.agent.stop()
    slow.release()

    expect(await pending).toMatchObject({ ok: false, title: 'Stopped', compiled: true })
    expect(ctx.sessions).toHaveLength(0)
    expect(ctx.events).toEqual([])
  })

  it('never falls back to the agent once a newer command replaced the replay', async () => {
    const slow = gatedTool({ ok: false, text: 'Spotify did not start playing' })
    const ctx = setup([CALENDAR], [reply('ok'), callTool('take_screenshot')], { runTool: slow.runTool })
    const pending = ctx.run('g-cal')
    await vi.waitFor(() => expect(slow.runTool).toHaveBeenCalled())
    const next = ctx.agent.start(request('Open Calculator'), ctx.emit)
    slow.release()

    expect(await pending).toMatchObject({ ok: false, title: 'Stopped' })
    const started = await next
    if (!started.ok) throw new Error(started.error)
    expect((await started.value.completion).kind).toBe('done')
    expect(ctx.sessions.flatMap((s) => s.prompts)).toEqual([expect.stringContaining('Message: Open Calculator')])
  })

  it('keeps the warm Droid session when a slow replay is replaced', async () => {
    vi.useFakeTimers()
    try {
      const slow = gatedTool({ ok: true, text: 'Shown' })
      const ctx = setup([CALENDAR], [reply('ok')], { runTool: slow.runTool })
      ctx.agent.init()
      const pending = ctx.run('g-cal')
      await vi.waitFor(() => expect(slow.runTool).toHaveBeenCalled())
      const next = ctx.agent.start(request('Open Calculator'), ctx.emit)
      await vi.advanceTimersByTimeAsync(3500)

      expect((await next).ok).toBe(true)
      expect(ctx.sessions).toHaveLength(1)
      expect(ctx.sessions[0].closed).toBe(false)
      slow.release()
      expect(await pending).toMatchObject({ title: 'Stopped' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the replay failure when the agent fallback is unavailable', async () => {
    const gesture: CustomGesture = { ...PEACE, id: 'g-4', builtin: false, compiled: [{ tool: 'read_calendar', args: {}, ok: true }] }
    const ctx = setup([gesture], [], { apiKey: () => undefined })
    expect(await ctx.run('g-4')).toMatchObject({ ok: false, title: 'Shortcut failed', subtitle: 'Calendar access was denied', compiled: false })
  })

  it('handles an unknown gesture', async () => {
    const ctx = setup([PEACE])
    expect(await ctx.run('nope')).toMatchObject({ ok: false, title: 'Unknown gesture' })
  })
})
