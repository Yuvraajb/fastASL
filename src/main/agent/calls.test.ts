import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineTool, type ToolDef, type ToolOutcome } from '../tools/types'
import { callsComplete, cleanReply, confirmDetailsFor, externalLabel, summarize, type Ending } from './calls'
import type { RecordedCall } from './types'
import { makeTools } from './testing/fakes'

const { tools } = makeTools()
const byName = (name: string) => tools.find((t) => t.name === name)!

function call(name: string, outcome: ToolOutcome): RecordedCall {
  return { def: byName(name), outcome, record: { tool: name, args: {}, ok: outcome.ok, result: outcome.text } }
}

const sent = call('send_message', { ok: true, text: 'Sent', title: 'Message sent', subtitle: 'To Mom' })
const notSent = call('send_message', { ok: false, text: 'No contact named Nobody' })
const shot = call('take_screenshot', { ok: true, text: 'Saved', title: 'Screenshot saved', subtitle: 'Desktop' })
const denied = call('read_calendar', { ok: false, text: 'Calendar access was denied' })

const complete: Ending = { complete: true, declined: false }
const unfinished: Ending = { complete: false, declined: false }
const declined: Ending = { complete: false, declined: true }

describe('callsComplete', () => {
  it.each([
    ['a lone successful call', [shot], false, true],
    ['a write retried after failing', [notSent, sent], false, true],
    ['a read failure the model worked around', [denied, shot], false, true],
    ['nothing at all', [], false, false],
    ['a declined task', [shot], true, false],
    ['a failing last call', [shot, denied], false, false],
    ['a write whose last attempt failed', [notSent, shot], false, false]
  ])('%s', (_, calls, wasDeclined, expected) => {
    expect(callsComplete(calls, wasDeclined)).toBe(expected)
  })
})

describe('summarize', () => {
  it('prefers the last successful write over later reads', () => {
    const view = { kind: 'openFile', path: '/tmp/a.png' } as const
    const result = summarize([sent, { ...shot, outcome: { ...shot.outcome, view } }], complete)
    expect(result).toMatchObject({ title: 'Message sent', subtitle: 'To Mom' })
    expect(result.view).toBeUndefined()
    expect(result.evidence).toHaveLength(2)
  })

  it('shows the last successful call and its view for a finished read-only task', () => {
    const view = { kind: 'openFile', path: '/tmp/a.png' } as const
    expect(summarize([denied, { ...shot, outcome: { ...shot.outcome, view } }], complete)).toMatchObject({
      title: 'Screenshot saved',
      subtitle: 'Desktop',
      view
    })
  })

  it('uses the tool text when the outcome has no title', () => {
    expect(summarize([call('take_screenshot', { ok: true, text: 'Saved to Desktop\nmore detail' })], complete)).toMatchObject({
      title: 'Saved to Desktop',
      subtitle: ''
    })
  })

  it('says why an unfinished task stopped short', () => {
    expect(summarize([shot, denied], unfinished)).toMatchObject({ title: 'Screenshot saved', subtitle: 'Calendar access was denied' })
    expect(summarize([notSent, shot], unfinished)).toMatchObject({ title: 'Screenshot saved', subtitle: 'No contact named Nobody' })
    expect(summarize([shot], { ...unfinished, error: 'Droid process exited' }).subtitle).toBe('Droid process exited')
    expect(summarize([sent], unfinished)).toMatchObject({ title: 'Message sent', subtitle: "The agent didn't finish" })
  })

  it('does not headline lookups for a task the user cancelled, but always shows a write that ran', () => {
    expect(summarize([shot], declined)).toMatchObject({ title: 'Nothing was done', subtitle: 'You cancelled it' })
    expect(summarize([sent, shot], declined)).toMatchObject({ title: 'Message sent', subtitle: 'You cancelled the rest' })
  })

  it('explains why nothing was done', () => {
    expect(summarize([], unfinished)).toMatchObject({ title: 'Nothing was done', subtitle: "The agent didn't run any action" })
    expect(summarize([denied], unfinished).subtitle).toBe('Calendar access was denied')
    expect(summarize([], declined).subtitle).toBe('You cancelled it')
  })
})

describe('the reply in summarize', () => {
  it('rides along with a finished turn, after tools or without any', () => {
    expect(summarize([], { ...unfinished, reply: 'Hello! How can I help?' })).toEqual({
      title: 'Nothing was done',
      subtitle: "The agent didn't run any action",
      evidence: [],
      reply: 'Hello! How can I help?'
    })
    expect(summarize([shot], { ...complete, reply: 'Saved it.' })).toMatchObject({ title: 'Screenshot saved', subtitle: 'Desktop', reply: 'Saved it.' })
  })

  it('is dropped after a decline, a stop or an error: it could describe what did not happen', () => {
    expect(summarize([], { ...declined, reply: 'Sent!' })).not.toHaveProperty('reply')
    expect(summarize([sent], { complete: false, declined: false, stopped: true, reply: 'Sent!' })).not.toHaveProperty('reply')
    expect(summarize([sent], { complete: false, declined: false, error: 'Droid process exited', reply: 'Sent!' })).not.toHaveProperty('reply')
  })
})

describe('cleanReply', () => {
  it('keeps plain words on one line', () => {
    expect(cleanReply('Hello!\n\nHow can I help?')).toBe('Hello! How can I help?')
    expect(cleanReply('**Sure.** It is `3:45 PM`.')).toBe('Sure. It is 3:45 PM.')
    expect(cleanReply('Options:\n- Open Notes\n- Search the web\n1. Done')).toBe('Options: Open Notes Search the web Done')
  })

  it('gives nothing for an empty reply, and cuts a runaway one', () => {
    expect(cleanReply(undefined)).toBeUndefined()
    expect(cleanReply('  \n ')).toBeUndefined()
    const long = cleanReply('word '.repeat(200))!
    expect(long.length).toBe(400)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('confirmDetailsFor', () => {
  const plain = defineTool({
    name: 'create_note',
    description: 'Create a note',
    schema: { title: z.string(), tags: z.array(z.string()) },
    risk: 'write',
    stepLabel: ({ title }) => `Creating note ${title}`,
    run: async () => ({ ok: true, text: 'ok' })
  }) as ToolDef

  it('uses the tool card when it has one', () => {
    expect(confirmDetailsFor(byName('send_message'), { to: 'Mom', text: 'hi' })).toEqual({ kind: 'message', to: 'Mom', text: 'hi' })
  })

  it('falls back to a generic card listing the args', () => {
    expect(confirmDetailsFor(plain, { title: 'Ideas', tags: ['work'] })).toEqual({
      kind: 'generic',
      title: 'Creating note Ideas',
      lines: ['title: Ideas', 'tags: ["work"]']
    })
  })

  it('survives a card builder that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken: ToolDef = { ...plain, confirmDetails: () => { throw new Error('bad date') } }
    expect(confirmDetailsFor(broken, { title: 'Ideas', tags: [] }).kind).toBe('generic')
    warn.mockRestore()
  })
})

describe('runs whose work happened inside an MCP server', () => {
  const ending = (extra: Partial<Ending> = {}): Ending => ({
    complete: true,
    declined: false,
    external: [{ tool: 'mcp__slack__slack_post_message' }],
    ...extra
  })

  it('reports what the agent said instead of "nothing was done"', () => {
    const result = summarize([], ending({ reply: 'The newest message asks about a League game. I replied that you are on your way.' }))
    expect(result.title).toContain('The newest message')
    expect(result.subtitle).toBe('slack/slack_post_message')
    expect(result.reply).toContain('on your way')
  })

  it('still says nothing was done when no external call ran either', () => {
    const result = summarize([], { complete: false, declined: false })
    expect(result.title).toBe('Nothing was done')
    expect(result.subtitle).toBe("The agent didn't run any action")
  })

  it('labels a tool id readably', () => {
    expect(externalLabel('mcp__slack__slack_post_message')).toBe('slack/slack_post_message')
    expect(externalLabel('slack___post_message')).toBe('slack/post_message')
    expect(externalLabel('plain')).toBe('plain')
  })
})
