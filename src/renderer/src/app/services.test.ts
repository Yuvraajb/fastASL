import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InterpretRequest, LlmStatusEvent, Result } from '@shared/types'
import { ipcServices } from './services'

/** The preload bridge's LLM slice: calls wait for the test, status events are pushed by hand. */
function stubBridge() {
  const listeners = new Set<(e: LlmStatusEvent) => void>()
  const calls: { callId?: string; answer: (res: Result<never[]>) => void }[] = []
  const api = {
    onLlmStatus: (cb: (e: LlmStatusEvent) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    interpret: vi.fn((_req: InterpretRequest, callId?: string) => new Promise((answer) => calls.push({ callId, answer }))),
    spellSuggest: vi.fn((_req: unknown, callId?: string) => new Promise((answer) => calls.push({ callId, answer }))),
    cancelLlm: vi.fn((_callId: string) => undefined)
  }
  vi.stubGlobal('window', { fastasl: api })
  return { api, calls, listeners, emit: (e: LlmStatusEvent) => listeners.forEach((l) => l(e)) }
}

const req: InterpretRequest = { tokens: ['HI'], sentence: 'hi', mode: 'command', frontmost: null, gestures: [] }

afterEach(() => vi.unstubAllGlobals())

describe('ipcServices LLM status', () => {
  it("passes each call only its own status lines, and stops listening once it settles", async () => {
    const bridge = stubBridge()
    const services = ipcServices()
    const first: string[] = []
    const second: string[] = []
    const a = services.interpret(req, (s) => first.push(s))
    const b = services.spellSuggest({ letters: 'KR', frontmost: null }, (s) => second.push(s))
    const [idA, idB] = bridge.calls.map((c) => c.callId)
    expect(idA).toBeTruthy()
    expect(idB).toBeTruthy()
    expect(idA).not.toBe(idB)

    bridge.emit({ callId: idA!, status: 'Rate limited, retrying...' })
    bridge.emit({ callId: 'someone-else', status: 'Rate limited, retrying...' })
    expect(first).toEqual(['Rate limited, retrying...'])
    expect(second).toEqual([])

    bridge.calls[0].answer({ ok: true, value: [] })
    await a
    expect(bridge.listeners.size).toBe(1)
    bridge.calls[1].answer({ ok: false, error: 'nope' })
    await b
    expect(bridge.listeners.size).toBe(0)
  })

  it('asks for no status without a listener', () => {
    const bridge = stubBridge()
    void ipcServices().interpret(req)
    expect(bridge.api.interpret).toHaveBeenCalledWith(req, undefined)
    expect(bridge.listeners.size).toBe(0)
  })
})

describe('ipcServices LLM cancel', () => {
  it('cancels the call in main when the card aborts it, and not after it settled', async () => {
    const bridge = stubBridge()
    const services = ipcServices()
    const first = new AbortController()
    const second = new AbortController()
    const a = services.interpret(req, undefined, first.signal)
    const b = services.spellSuggest({ letters: 'KR', frontmost: null }, () => undefined, second.signal)
    const [idA, idB] = bridge.calls.map((c) => c.callId)
    expect(idA).toBeTruthy()

    first.abort()
    expect(bridge.api.cancelLlm).toHaveBeenCalledWith(idA)
    bridge.calls[0].answer({ ok: false, error: 'Cancelled' })
    await a

    bridge.calls[1].answer({ ok: true, value: [] })
    await b
    second.abort()
    expect(bridge.api.cancelLlm).not.toHaveBeenCalledWith(idB)
    expect(bridge.api.cancelLlm).toHaveBeenCalledTimes(1)
  })

  it('never sends a call the card dropped before it started', async () => {
    const bridge = stubBridge()
    const dropped = new AbortController()
    dropped.abort()
    expect(await ipcServices().interpret(req, () => undefined, dropped.signal)).toEqual({ ok: false, error: 'Cancelled' })
    expect(bridge.api.interpret).not.toHaveBeenCalled()
    expect(bridge.listeners.size).toBe(0)
  })
})
