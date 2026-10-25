import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shared/types'
import { ChatService, MISSING_KEY_ERROR, type ChatPiece, type ChatSessionLike } from './chatService'

function fakeSession(turns: ChatPiece[][]): ChatSessionLike & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async *stream(prompt) {
      prompts.push(prompt)
      for (const piece of turns.shift() ?? []) yield piece
    },
    close: vi.fn(async () => undefined)
  }
}

function setup(session: ChatSessionLike, over: Partial<ConstructorParameters<typeof ChatService>[0]> = {}) {
  const events: ChatEvent[] = []
  const service = new ChatService({
    openSession: async () => session,
    apiKey: () => 'fk-test',
    droidPath: async () => ({ ok: true, value: '/bin/droid' }),
    cwd: '/tmp',
    ...over
  })
  const idle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
  }
  return { service, events, emit: (e: ChatEvent) => events.push(e), idle }
}

describe('ChatService', () => {
  it('streams the reply as deltas, then done', async () => {
    const session = fakeSession([[{ kind: 'delta', text: 'Hi' }, { kind: 'delta', text: ' there' }, { kind: 'end', ok: true, interrupted: false }]])
    const { service, events, emit, idle } = setup(session)
    expect(service.send('m1', ' hello ', emit)).toEqual({ ok: true, value: undefined })
    await idle()
    expect(session.prompts).toEqual(['hello'])
    expect(events).toEqual([
      { type: 'delta', id: 'm1', text: 'Hi' },
      { type: 'delta', id: 'm1', text: ' there' },
      { type: 'done', id: 'm1' }
    ])
  })

  it('keeps one conversation across messages and runs them one at a time', async () => {
    const session = fakeSession([[{ kind: 'delta', text: 'a' }], [{ kind: 'delta', text: 'b' }]])
    const open = vi.fn(async () => session)
    const { service, events, emit, idle } = setup(session, { openSession: open })
    service.send('1', 'one', emit)
    service.send('2', 'two', emit)
    await idle()
    expect(open).toHaveBeenCalledTimes(1)
    expect(events.map((e) => `${e.type}:${e.id}`)).toEqual(['delta:1', 'done:1', 'delta:2', 'done:2'])
  })

  it('refuses an empty message', () => {
    const { service, emit } = setup(fakeSession([]))
    expect(service.send('x', '   ', emit).ok).toBe(false)
  })

  it('says to add the key when there is none, and tries again once it is added', async () => {
    let key: string | undefined
    const session = fakeSession([[{ kind: 'delta', text: 'ok' }]])
    const { service, events, emit, idle } = setup(session, { apiKey: () => key })
    service.send('1', 'hello', emit)
    await idle()
    expect(events).toEqual([{ type: 'error', id: '1', message: MISSING_KEY_ERROR }])
    key = 'fk-test'
    service.send('2', 'hello', emit)
    await idle()
    expect(events.at(-1)).toEqual({ type: 'done', id: '2' })
  })

  it('passes on a missing droid CLI', async () => {
    const { service, events, emit, idle } = setup(fakeSession([]), { droidPath: async () => ({ ok: false, error: 'Install the droid CLI' }) })
    service.send('1', 'hi', emit)
    await idle()
    expect(events).toEqual([{ type: 'error', id: '1', message: 'Install the droid CLI' }])
  })

  it('reports a model error once, not as done', async () => {
    const session = fakeSession([[{ kind: 'error', message: 'rate limited' }, { kind: 'end', ok: false, interrupted: false }]])
    const { service, events, emit, idle } = setup(session)
    service.send('1', 'hi', emit)
    await idle()
    expect(events).toEqual([{ type: 'error', id: '1', message: 'rate limited' }])
  })

  it('stop() interrupts the reply and ends quietly', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const session: ChatSessionLike = {
      async *stream(_p, signal) {
        yield { kind: 'delta', text: 'part' }
        await gate
        if (signal.aborted) throw new Error('aborted')
      },
      close: async () => undefined
    }
    const { service, events, emit, idle } = setup(session)
    service.send('1', 'hi', emit)
    await idle()
    service.stop()
    release()
    await idle()
    expect(events.map((e) => e.type)).toEqual(['delta', 'done'])
  })

  it('reset() closes the session so the next message starts a new conversation', async () => {
    const session = fakeSession([[{ kind: 'delta', text: 'a' }], [{ kind: 'delta', text: 'b' }]])
    const open = vi.fn(async () => session)
    const { service, emit, idle } = setup(session, { openSession: open })
    service.send('1', 'one', emit)
    await idle()
    await service.reset()
    service.send('2', 'two', emit)
    await idle()
    expect(open).toHaveBeenCalledTimes(2)
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})
