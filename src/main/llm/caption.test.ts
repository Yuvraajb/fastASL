import { describe, expect, it, vi } from 'vitest'
import { keepsEverySign, translateGlosses, type CaptionDeps } from './caption'
import type { OllamaChatRequest } from './local'

const config = (): { url: string; model: string } => ({ url: 'http://127.0.0.1:11434', model: 'llama3.2' })

function answering(content: string): { deps: CaptionDeps; calls: OllamaChatRequest[] } {
  const calls: OllamaChatRequest[] = []
  const chat = vi.fn(() => async (body: OllamaChatRequest) => {
    calls.push(body)
    return { model: body.model, message: { role: 'assistant' as const, content }, done: true }
  })
  return { deps: { chat, config }, calls }
}

describe('keepsEverySign', () => {
  it('accepts a sentence that says every sign, in a longer form or a listed synonym', () => {
    expect(keepsEverySign(['TOMORROW', 'TIME', 'WHAT', 'MEETING'], 'What time is the meeting tomorrow?')).toBe(true)
    expect(keepsEverySign(['MOM', 'CALL', 'TOMORROW'], 'I will be calling my mother tomorrow.')).toBe(true)
    expect(keepsEverySign(['HELLO', 'FRIEND'], 'Hi, friend!')).toBe(true)
    expect(keepsEverySign(['thank you', 'FRIEND'], 'Thanks, friend.')).toBe(true)
    expect(keepsEverySign(['ME', 'EMAIL', 'DAD'], 'I emailed my father.')).toBe(true)
  })

  it('refuses a sentence that drops or swaps a sign', () => {
    expect(keepsEverySign(['YES', 'FRIEND'], "I'm okay, friend.")).toBe(false)
    expect(keepsEverySign(['CALL', 'FRIEND'], 'I will email my friend.')).toBe(false)
    expect(keepsEverySign(['TOMORROW', 'MEETING'], 'The meeting is today.')).toBe(false)
  })
})

describe('translateGlosses', () => {
  it('asks the local model for one sentence and returns it', async () => {
    const { deps, calls } = answering('{"sentence": "What time is the meeting tomorrow?"}')
    const res = await translateGlosses(['tomorrow', 'time', 'what', 'meeting'], deps)
    expect(res).toEqual({ ok: true, value: 'What time is the meeting tomorrow?' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'llama3.2', stream: false, keep_alive: '30m', options: { temperature: 0 } })
    expect(calls[0].messages.at(-1)).toEqual({ role: 'user', content: 'TOMORROW TIME WHAT MEETING' })
    expect(calls[0].messages[0].role).toBe('system')
  })

  it('refuses a sentence that leaves out a sign, so the caption keeps the signs', async () => {
    const { deps } = answering('{"sentence": "I\'m okay."}')
    const res = await translateGlosses(['YES', 'PLEASE'], deps)
    expect(res.ok).toBe(false)
  })

  it('fails cleanly on a reply that is not the JSON asked for, or no server', async () => {
    expect((await translateGlosses(['CALL', 'FRIEND'], answering('Call my friend.').deps)).ok).toBe(false)
    expect((await translateGlosses(['CALL', 'FRIEND'], answering('{"sentence": ""}').deps)).ok).toBe(false)
    const down: CaptionDeps = {
      config,
      chat: () => async () => {
        throw new Error('fetch failed')
      }
    }
    expect(await translateGlosses(['CALL', 'FRIEND'], down)).toEqual({ ok: false, error: 'fetch failed' })
    expect((await translateGlosses([' '], answering('{}').deps)).ok).toBe(false)
  })
})
