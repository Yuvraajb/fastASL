import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { MODEL, getClaude } from './client'
import { fakeClaude, lastUserText } from './fakeClaude'
import { askJson, extractJson } from './structured'

const Schema = z.object({ word: z.string(), score: z.number() })

async function ask(...replies: Parameters<typeof fakeClaude>) {
  const fake = fakeClaude(...replies)
  const client = fake.provider()
  if (!client.ok) throw new Error('fake provider failed')
  const result = await askJson(client.value, { system: 'SYS', user: 'USER', schema: Schema, maxTokens: 300 })
  return { result, calls: fake.calls }
}

describe('extractJson', () => {
  it('unwraps markdown fences and surrounding prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJson('Sure! Here it is: {"a":{"b":2}} Hope that helps.')).toBe('{"a":{"b":2}}')
  })

  it('returns text without an object unchanged', () => {
    expect(extractJson('no json here')).toBe('no json here')
  })
})

describe('askJson', () => {
  it('sends a low-latency structured-output request and returns the parsed value', async () => {
    const { result, calls } = await ask('{"word":"hello","score":0.5}')

    expect(result).toEqual({ ok: true, value: { word: 'hello', score: 0.5 } })
    expect(calls).toHaveLength(1)
    const params = calls[0]
    expect(params.model).toBe(MODEL)
    expect(params.max_tokens).toBe(300)
    expect(params.thinking).toEqual({ type: 'between_tools' })
    expect(params.output_config?.effort).toBe('low')
    expect(params.output_config?.format).toMatchObject({
      type: 'json_schema',
      schema: { type: 'object', additionalProperties: false, required: ['word', 'score'] }
    })
    expect(params.fallbacks).toBe('default')
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(params.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }])
    expect(params.messages).toEqual([{ role: 'user', content: 'USER' }])
  })

  it('tolerates markdown-fenced JSON without retrying', async () => {
    const { result, calls } = await ask('```json\n{"word":"hi","score":1}\n```')
    expect(result).toEqual({ ok: true, value: { word: 'hi', score: 1 } })
    expect(calls).toHaveLength(1)
  })

  it('retries once with a corrective follow-up after invalid JSON', async () => {
    const { result, calls } = await ask('{"word": "hi", oops', '{"word":"hi","score":0.9}')

    expect(result).toEqual({ ok: true, value: { word: 'hi', score: 0.9 } })
    expect(calls).toHaveLength(2)
    expect(calls[0].messages).toHaveLength(1)
    const retry = calls[1].messages
    expect(retry.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(retry[1].content)).toContain('oops')
    expect(lastUserText(calls[1])).toMatch(/not valid JSON/)
  })

  it('names the failing field when the reply misses the schema', async () => {
    const { result, calls } = await ask('{"word":"hi","score":"high"}', '{"word":"hi","score":0.7}')
    expect(result.ok).toBe(true)
    expect(lastUserText(calls[1])).toMatch(/score/)
  })

  it('fails with an error when the retry is also unusable', async () => {
    const { result, calls } = await ask('nope', '{"word":42}')
    expect(calls).toHaveLength(2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/unusable reply/)
  })

  it('does not echo an empty reply back on retry', async () => {
    const { result, calls } = await ask('', '{"word":"hi","score":1}')
    expect(result.ok).toBe(true)
    expect(calls[1].messages.map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('asks for a shorter reply when the first one was cut off', async () => {
    const cutOff = { text: '{"word":"hel', stop_reason: 'max_tokens' as const }
    const { result, calls } = await ask(cutOff, '{"word":"hello","score":1}')
    expect(result.ok).toBe(true)
    expect(lastUserText(calls[1])).toMatch(/cut off/)
  })

  it('does not retry a refusal', async () => {
    const { result, calls } = await ask({ text: '', stop_reason: 'refusal' })
    expect(calls).toHaveLength(1)
    expect(result).toEqual({ ok: false, error: 'Claude declined to answer this one' })
  })

  it('maps SDK errors to soft errors without retrying', async () => {
    const timeout = await ask(new Anthropic.APIConnectionTimeoutError())
    expect(timeout.calls).toHaveLength(1)
    expect(timeout.result).toEqual({ ok: false, error: 'Claude took too long to answer' })

    // A present-but-wrong key must not claim the key is missing.
    const auth = await ask(new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()))
    expect(auth.result).toEqual({ ok: false, error: 'Claude rejected ANTHROPIC_API_KEY. Check .env' })

    const busy = await ask(new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers()))
    expect(busy.result).toMatchObject({ ok: false, error: expect.stringMatching(/busy/) })
  })
})

describe('askJson deadline', () => {
  const TOO_SLOW = { ok: false, error: 'Claude took too long to answer' }
  const request = { system: 'SYS', user: 'USER', schema: Schema, maxTokens: 300 }

  /** Never answers; rejects like the SDK once the request's signal aborts. */
  const hang = (signal: AbortSignal) =>
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true })
    )
  const after = (ms: number, text: string) => () => new Promise<string>((resolve) => setTimeout(resolve, ms, text))

  function start(...replies: Parameters<typeof fakeClaude>) {
    const fake = fakeClaude(...replies)
    const client = fake.provider()
    if (!client.ok) throw new Error('fake provider failed')
    let settled = false
    const result = askJson(client.value, request).finally(() => (settled = true))
    return { result, fake, settled: () => settled }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shares one signal across both attempts and clears its timer when done', async () => {
    const { result, fake } = start('nope', '{"word":"hi","score":1}')
    expect((await result).ok).toBe(true)
    expect(fake.signals).toHaveLength(2)
    expect(fake.signals[1]).toBe(fake.signals[0])
    expect(fake.signals[0].aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up after 15 s in total when Claude does not answer', async () => {
    const run = start(hang)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(run.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run.result).toEqual(TOO_SLOW)
    expect(run.fake.signals[0].aborted).toBe(true)
  })

  it('counts the corrective retry against the same 15 s', async () => {
    const run = start(after(10_000, 'nope'), hang)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await run.result).toEqual(TOO_SLOW)
    expect(run.fake.calls).toHaveLength(2)
  })

  it('sends no corrective retry once the deadline has passed', async () => {
    const run = start(after(16_000, 'nope'))
    await vi.advanceTimersByTimeAsync(16_000)
    expect(await run.result).toEqual(TOO_SLOW)
    expect(run.fake.calls).toHaveLength(1)
  })

  it("cuts the SDK's retry-after wait short at the deadline", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' }
        })
    )
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-deadline')
    const client = getClaude()
    vi.unstubAllEnvs()
    if (!client.ok) throw new Error('expected a client')

    let settled = false
    const result = askJson(client.value, request).finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual(TOO_SLOW)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
