import { afterAll, describe, expect, it, vi } from 'vitest'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'

const sdk = vi.hoisted(() => ({
  instances: [] as { options: unknown; create: (p: unknown, o: unknown) => Promise<unknown> }[]
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    beta: { messages: { create: (p: unknown, o: unknown) => Promise<unknown> } }
    constructor(options: unknown) {
      const create = vi.fn(async () => ({ id: 'msg_1' }))
      this.beta = { messages: { create } }
      sdk.instances.push({ options, create })
    }
  }
}))

import { getClaude } from './client'

const original = process.env.ANTHROPIC_API_KEY
afterAll(() => {
  if (original === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = original
})

describe('getClaude', () => {
  it('reports a missing key without building a client', () => {
    process.env.ANTHROPIC_API_KEY = '  '
    expect(getClaude()).toEqual({
      ok: false,
      error: 'Add ANTHROPIC_API_KEY to .env',
      missingKey: 'ANTHROPIC_API_KEY'
    })
    expect(sdk.instances).toHaveLength(0)
  })

  it('builds the client lazily, once, with a single SDK retry', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-1'
    const first = getClaude()
    const second = getClaude()

    expect(sdk.instances).toHaveLength(1)
    // No per-attempt timeout: askJson's deadline signal bounds the whole call.
    expect(sdk.instances[0].options).toEqual({ apiKey: 'sk-test-1', maxRetries: 1 })
    if (!first.ok || !second.ok) throw new Error('expected a client')
    expect(second.value).toBe(first.value)

    const params = { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] } as MessageCreateParamsNonStreaming
    const { signal } = new AbortController()
    await first.value(params, { signal })
    expect(sdk.instances[0].create).toHaveBeenCalledWith(params, { signal })
  })

  it('rebuilds the client when the key changes', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-2'
    expect(getClaude().ok).toBe(true)
    expect(sdk.instances).toHaveLength(2)
    expect(sdk.instances[1].options).toMatchObject({ apiKey: 'sk-test-2' })
  })
})
