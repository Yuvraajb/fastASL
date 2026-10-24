import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  FinishReason,
  ThinkingLevel,
  Type,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse
} from '@google/genai'
import { z } from 'zod/v4'
import { IntentReply } from '../claude/intent'
import { SpellReply } from '../claude/spell'
import {
  DEFAULT_GEMINI_MODEL,
  LOW_THINKING_ALLOWANCE,
  RATE_LIMITED_STATUS,
  geminiLlm,
  geminiSchema,
  geminiSource,
  getGemini,
  nextRateLimitWait,
  quotaFailure,
  rateLimitBudget,
  retryDelayMs,
  thinkingAllowance,
  thinkingFor,
  type GenerateContent
} from './gemini'
import { CANCELLED } from './structured'

const sdk = vi.hoisted(() => ({ instances: [] as unknown[] }))

// The real SDK, except that building a client is recorded and never touches the network.
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>()
  class FakeGoogleGenAI {
    models = { generateContent: vi.fn(async () => ({})) }
    constructor(options: unknown) {
      sdk.instances.push(options)
    }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI }
})

const Schema = z.object({ word: z.string(), score: z.number() })
const request = { system: 'SYS', user: 'USER', schema: Schema, maxTokens: 300 }

type FakeReply = GenerateContentResponse | Error | ((signal: AbortSignal) => Promise<GenerateContentResponse>)

/** A scripted generateContent: replies in order, recording every request. */
function fakeGemini(...replies: FakeReply[]) {
  const calls: GenerateContentParameters[] = []
  const queue = [...replies]
  const generate: GenerateContent = async (params) => {
    calls.push(params)
    const next = queue.shift()
    if (next === undefined) throw new Error('fakeGemini: no reply queued')
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(params.config!.abortSignal!) : next
  }
  return { generate, calls }
}

function reply(text: string, finishReason: FinishReason = FinishReason.STOP): GenerateContentResponse {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text, thoughtSignature: 'sig' }] }, finishReason }]
  } as GenerateContentResponse
}

/** A 429 exactly as the SDK throws it: the response body JSON in `message`. */
function rateLimited(
  retryDelay?: string,
  { quotaId, quotaValue = '15', message = 'Resource has been exhausted.' }: { quotaId?: string; quotaValue?: string; message?: string } = {}
): ApiError {
  const details: object[] = []
  if (quotaId) {
    details.push({ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue }] })
  }
  if (retryDelay) details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay })
  const body = { error: { code: 429, message, status: 'RESOURCE_EXHAUSTED', details } }
  return new ApiError({ status: 429, message: JSON.stringify(body) })
}

const PER_MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'
const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'

const apiError = (status: number, body: object): ApiError => new ApiError({ status, message: JSON.stringify(body) })

const userText = (content: Content): string => content.parts?.map((p) => p.text).join('') ?? ''

/** Never answers; rejects like the SDK once the request's signal aborts. */
const hang = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), {
      once: true
    })
  )

describe('geminiSchema', () => {
  it('is the intent JSON exactly: every field, required, in order, intent nullable', () => {
    const fields = Object.keys(IntentReply.shape)
    expect(geminiSchema(IntentReply)).toEqual({
      type: Type.OBJECT,
      properties: {
        sentence: { type: Type.STRING },
        intent: { type: Type.STRING, nullable: true },
        alternatives: { type: Type.ARRAY, items: { type: Type.STRING } },
        confidence: { type: Type.NUMBER },
        needs_confirmation: { type: Type.BOOLEAN },
        context_actions: { type: Type.ARRAY, items: { type: Type.STRING } }
      },
      required: fields,
      propertyOrdering: fields
    })
  })

  it('is the spelling JSON exactly', () => {
    expect(geminiSchema(SpellReply)).toEqual({
      type: Type.OBJECT,
      properties: { suggestions: { type: Type.ARRAY, items: { type: Type.STRING } } },
      required: ['suggestions'],
      propertyOrdering: ['suggestions']
    })
  })

  it('refuses schemas it cannot express rather than sending a looser one', () => {
    expect(() => geminiSchema(z.object({ a: z.union([z.string(), z.number()]) }))).toThrow(/unsupported/)
  })
})

describe('thinkingFor', () => {
  it('keeps thinking as low as each model allows, never both fields', () => {
    expect(thinkingFor(DEFAULT_GEMINI_MODEL)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL })
    expect(thinkingFor('gemini-3.8-flash')).toEqual({ thinkingLevel: ThinkingLevel.LOW })
    expect(thinkingFor('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 })
    expect(thinkingFor('gemini-2.5-pro')).toEqual({ thinkingBudget: 128 })
    expect(thinkingFor('gemini-2.0-flash')).toBeUndefined()
  })

  it('reads a "models/" id like the bare one', () => {
    expect(thinkingFor('models/gemini-2.5-flash')).toEqual({ thinkingBudget: 0 })
    expect(thinkingFor('models/gemini-3.5-flash-lite')).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL })
  })

  it('leaves room for the thinking a model cannot turn off, on top of the answer', () => {
    expect(thinkingAllowance(DEFAULT_GEMINI_MODEL)).toBe(0)
    expect(thinkingAllowance('gemini-2.5-flash')).toBe(0)
    expect(thinkingAllowance('gemini-2.0-flash')).toBe(0)
    expect(thinkingAllowance('gemini-2.5-pro')).toBe(128)
    expect(thinkingAllowance('gemini-3.8-flash')).toBe(LOW_THINKING_ALLOWANCE)
  })
})

describe('getGemini', () => {
  const original = process.env.GEMINI_API_KEY
  afterEach(() => {
    if (original === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = original
  })

  it('reports a missing key without building a client', () => {
    process.env.GEMINI_API_KEY = '  '
    expect(getGemini()).toEqual({ ok: false, error: 'Add GEMINI_API_KEY to .env', missingKey: 'GEMINI_API_KEY' })
    expect(sdk.instances).toHaveLength(0)
  })

  it('builds the client once per key, on the Developer API, with the SDK retries off', () => {
    process.env.GEMINI_API_KEY = 'test-key-1'
    const first = getGemini()
    const second = getGemini()
    expect(sdk.instances).toEqual([
      { apiKey: 'test-key-1', vertexai: false, httpOptions: { retryOptions: { attempts: 1 } } }
    ])
    if (!first.ok || !second.ok) throw new Error('expected a client')
    expect(second.value).toBe(first.value)
    process.env.GEMINI_API_KEY = 'test-key-2'
    expect(getGemini().ok).toBe(true)
    expect(sdk.instances).toHaveLength(2)
  })

  it('geminiSource passes the missing key on, so the card can say which key to add', () => {
    process.env.GEMINI_API_KEY = ''
    expect(geminiSource()()).toMatchObject({ ok: false, missingKey: 'GEMINI_API_KEY' })
  })
})

describe('Gemini structured output', () => {
  it('sends JSON mode with the schema, a 300-token cap and minimal thinking, and parses the reply', async () => {
    const fake = fakeGemini(reply('{"word":"hello","score":0.5}'))
    const llm = geminiLlm(fake.generate, DEFAULT_GEMINI_MODEL)
    expect(llm.maxTokens).toEqual({ intent: 300, spell: 300 })

    const result = await llm.ask(request)
    expect(result).toEqual({ ok: true, value: { word: 'hello', score: 0.5 } })
    expect(fake.calls).toHaveLength(1)
    const { model, contents, config } = fake.calls[0]
    expect(model).toBe(DEFAULT_GEMINI_MODEL)
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'USER' }] }])
    expect(config).toMatchObject({
      systemInstruction: 'SYS',
      responseMimeType: 'application/json',
      responseSchema: geminiSchema(Schema),
      maxOutputTokens: 300,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      automaticContinuation: false
    })
    expect(config?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(config).not.toHaveProperty('temperature')
  })

  it('caps the answer, not the thinking, on a model that has to think', async () => {
    const fake = fakeGemini(reply('{"word":"hello","score":0.5}'))
    await geminiLlm(fake.generate, 'gemini-3.8-flash').ask(request)
    expect(fake.calls[0].config).toMatchObject({
      maxOutputTokens: 300 + LOW_THINKING_ALLOWANCE,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
    })
  })

  it('retries once after an unusable reply, echoing the model turn unchanged', async () => {
    const fake = fakeGemini(reply('{"word": "hi", oops'), reply('{"word":"hi","score":0.9}'))
    const result = await geminiLlm(fake.generate, DEFAULT_GEMINI_MODEL).ask(request)

    expect(result).toEqual({ ok: true, value: { word: 'hi', score: 0.9 } })
    expect(fake.calls).toHaveLength(2)
    const retry = fake.calls[1].contents as Content[]
    expect(retry.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(retry[1]).toEqual({ role: 'model', parts: [{ text: '{"word": "hi", oops', thoughtSignature: 'sig' }] })
    expect(userText(retry[2])).toMatch(/not valid JSON/)
  })

  it('gives up after the one retry', async () => {
    const fake = fakeGemini(reply('nope'), reply('{"word":42}'))
    const result = await geminiLlm(fake.generate, DEFAULT_GEMINI_MODEL).ask(request)
    expect(fake.calls).toHaveLength(2)
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^Gemini returned an unusable reply \(/) })
  })

  it('asks for a shorter reply after MAX_TOKENS, and skips echoing an empty turn', async () => {
    const cutOff = { candidates: [{ finishReason: FinishReason.MAX_TOKENS }] } as GenerateContentResponse
    const fake = fakeGemini(cutOff, reply('{"word":"hello","score":1}'))
    const result = await geminiLlm(fake.generate, DEFAULT_GEMINI_MODEL).ask(request)

    expect(result.ok).toBe(true)
    const retry = fake.calls[1].contents as Content[]
    expect(retry.map((c) => c.role)).toEqual(['user', 'user'])
    expect(userText(retry[1])).toMatch(/cut off/)
  })

  it('does not retry a blocked prompt or answer', async () => {
    const blocked = { promptFeedback: { blockReason: 'SAFETY' } } as GenerateContentResponse
    const prompt = fakeGemini(blocked)
    expect(await geminiLlm(prompt.generate, DEFAULT_GEMINI_MODEL).ask(request)).toEqual({
      ok: false,
      error: 'Gemini declined to answer this one'
    })
    expect(prompt.calls).toHaveLength(1)

    const answer = fakeGemini(reply('', FinishReason.SAFETY))
    expect((await geminiLlm(answer.generate, DEFAULT_GEMINI_MODEL).ask(request)).ok).toBe(false)
    expect(answer.calls).toHaveLength(1)
  })

  it('maps API errors to short messages without retrying', async () => {
    const ask = async (err: Error) => {
      const fake = fakeGemini(err)
      const result = await geminiLlm(fake.generate, 'gemini-x').ask(request)
      expect(fake.calls).toHaveLength(1)
      return result
    }
    // A present-but-wrong key must not claim the key is missing.
    expect(
      await ask(
        apiError(400, {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]
          }
        })
      )
    ).toEqual({ ok: false, error: 'Gemini rejected GEMINI_API_KEY. Check .env' })
    expect(await ask(apiError(404, { error: { code: 404, message: 'models/gemini-x is not found', status: 'NOT_FOUND' } }))).toEqual({
      ok: false,
      error: 'Gemini has no model "gemini-x". Check GEMINI_MODEL in .env'
    })
    expect(await ask(apiError(503, { error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } }))).toEqual({
      ok: false,
      error: 'Gemini is busy right now. Try again in a moment'
    })
    expect(await ask(apiError(400, { error: { code: 400, message: 'Bad schema', status: 'INVALID_ARGUMENT' } }))).toEqual({
      ok: false,
      error: 'Gemini error: Bad schema'
    })
    expect(await ask(new TypeError('fetch failed'))).toEqual({ ok: false, error: "Can't reach Gemini. Check your connection" })
  })
})

describe('Gemini rate limits (HTTP 429)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // no jitter
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function start(...replies: FakeReply[]) {
    const fake = fakeGemini(...replies)
    const statuses: { at: number; status: string }[] = []
    const t0 = Date.now()
    let settled = false
    const result = geminiLlm(fake.generate, DEFAULT_GEMINI_MODEL)
      .ask({ ...request, onStatus: (status) => statuses.push({ at: Date.now() - t0, status }) })
      .finally(() => (settled = true))
    return { result, fake, statuses, settled: () => settled }
  }

  it('retries 3 times after 1 s, 2 s and 4 s, saying so each time, then shows an error', async () => {
    const run = start(rateLimited(), rateLimited(), rateLimited(), rateLimited())
    await vi.advanceTimersByTimeAsync(0)
    expect(run.fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(run.fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run.fake.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(run.fake.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(run.fake.calls).toHaveLength(4)

    expect(await run.result).toEqual({ ok: false, error: 'Gemini is rate limited. Try again in a minute' })
    expect(run.statuses).toEqual([
      { at: 0, status: RATE_LIMITED_STATUS },
      { at: 1000, status: RATE_LIMITED_STATUS },
      { at: 3000, status: RATE_LIMITED_STATUS }
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers once the limit lifts, waiting what the server asked', async () => {
    const run = start(rateLimited('2s'), reply('{"word":"hi","score":1}'))
    await vi.advanceTimersByTimeAsync(1999)
    expect(run.fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run.result).toEqual({ ok: true, value: { word: 'hi', score: 1 } })
    expect(run.fake.calls).toHaveLength(2)
    expect(run.statuses).toEqual([{ at: 0, status: RATE_LIMITED_STATUS }])
    // The retry is the same request, not a corrective one.
    expect(run.fake.calls[1].contents).toEqual(run.fake.calls[0].contents)
  })

  it('waits as long as the server asks when the retry still fits before the deadline', async () => {
    const run = start(rateLimited('20s', { quotaId: PER_MINUTE }), reply('{"word":"hi","score":1}'))
    await vi.advanceTimersByTimeAsync(19_999)
    expect(run.fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await run.result).ok).toBe(true)
    expect(run.statuses).toEqual([{ at: 0, status: RATE_LIMITED_STATUS }])
  })

  it('says at once how long to wait when the server asks for longer than the deadline allows', async () => {
    const run = start(rateLimited('51s', { quotaId: PER_MINUTE, message: 'Please retry in 50.2s.' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(await run.result).toEqual({ ok: false, error: 'Gemini is rate limited. Try again in 51 s' })
    expect(run.fake.calls).toHaveLength(1)
    expect(run.statuses).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry a used-up daily quota, and says so', async () => {
    const run = start(rateLimited('40s', { quotaId: PER_DAY }))
    await vi.advanceTimersByTimeAsync(0)
    expect(await run.result).toEqual({
      ok: false,
      error: "Gemini's daily quota is used up. Try tomorrow or set LLM_PROVIDER=claude"
    })
    expect(run.fake.calls).toHaveLength(1)
    expect(run.statuses).toEqual([])
  })

  it('does not retry a model with no free-tier quota', async () => {
    const run = start(rateLimited(undefined, { quotaId: PER_MINUTE, quotaValue: '0' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(await run.result).toEqual({
      ok: false,
      error: `Gemini has no quota for ${DEFAULT_GEMINI_MODEL} on this key. Change GEMINI_MODEL in .env`
    })
    expect(run.fake.calls).toHaveLength(1)
  })

  it('shares the 3 retries between the first try and the corrective one', async () => {
    const run = start(rateLimited(), rateLimited(), rateLimited(), reply('nope'), rateLimited())
    await vi.advanceTimersByTimeAsync(7000)
    expect(await run.result).toEqual({ ok: false, error: 'Gemini is rate limited. Try again in a minute' })
    expect(run.fake.calls).toHaveLength(5)
    expect(run.statuses).toHaveLength(3)
  })

  it('stops waiting and sends nothing more once the card cancels the call', async () => {
    const fake = fakeGemini(rateLimited(), reply('{"word":"hi","score":1}'))
    const cancel = new AbortController()
    const result = geminiLlm(fake.generate, DEFAULT_GEMINI_MODEL).ask({ ...request, signal: cancel.signal })
    await vi.advanceTimersByTimeAsync(500)
    cancel.abort()
    expect(await result).toEqual(CANCELLED)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives each request 15 s, and the whole exchange 30 s', async () => {
    const stalled = start(hang)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(stalled.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await stalled.result).toEqual({ ok: false, error: 'Gemini took too long to answer' })

    // Rate limited for 2 x 9 s, then an answer that needs correcting, then a stalled correction.
    const slow = start(
      rateLimited('9s'),
      rateLimited('9s'),
      () => new Promise((resolve) => setTimeout(resolve, 10_000, reply('nope'))),
      hang
    )
    await vi.advanceTimersByTimeAsync(29_999)
    expect(slow.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await slow.result).toEqual({ ok: false, error: 'Gemini took too long to answer' })
    expect(slow.fake.calls).toHaveLength(4)
  })
})

describe('rate-limit waits', () => {
  it('reads RetryInfo, or the more exact "retry in" of the message', () => {
    expect(retryDelayMs(rateLimited('7s'))).toBe(7000)
    expect(retryDelayMs(rateLimited('0.5s'))).toBe(500)
    expect(retryDelayMs(rateLimited('37s', { message: 'You exceeded your current quota. Please retry in 37.4s.' }))).toBe(37_400)
    expect(retryDelayMs(rateLimited(undefined, { message: 'Please retry in 12s.' }))).toBe(12_000)
    expect(retryDelayMs(rateLimited(undefined, { message: 'Please retry in 450ms.' }))).toBeNull()
    expect(retryDelayMs(rateLimited())).toBeNull()
    expect(retryDelayMs(new ApiError({ status: 429, message: 'not json' }))).toBeNull()
  })

  it('reads a per-day or zero quota from QuotaFailure', () => {
    expect(quotaFailure(rateLimited('9s', { quotaId: PER_MINUTE }))).toEqual({ daily: false, none: false })
    expect(quotaFailure(rateLimited('9s', { quotaId: PER_DAY }))).toEqual({ daily: true, none: false })
    expect(quotaFailure(rateLimited(undefined, { quotaId: PER_MINUTE, quotaValue: '0' }))).toEqual({ daily: false, none: true })
    expect(quotaFailure(rateLimited(undefined, { message: 'Quota exceeded for metric: x, limit: 0, model: y' }))).toEqual({
      daily: false,
      none: true
    })
    expect(quotaFailure(new ApiError({ status: 429, message: 'not json' }))).toEqual({ daily: false, none: false })
  })

  it('waits what the server asks, or 1/2/4 s with a little jitter, while retries and time are left', () => {
    const now = 1_000_000
    const budget = (retriesLeft = 3, elapsed = 0) => ({ ...rateLimitBudget(now - elapsed), retriesLeft })
    expect(nextRateLimitWait(rateLimited('0.5s'), budget(1), now)).toBe(500)
    expect(nextRateLimitWait(rateLimited('25s'), budget(), now)).toBe(25_000)
    expect(nextRateLimitWait(rateLimited('26s'), budget(), now)).toBeNull() // leaves under 5 s to answer
    expect(nextRateLimitWait(rateLimited('9s'), budget(3, 20_000), now)).toBeNull()
    expect(nextRateLimitWait(rateLimited('1s'), budget(0), now)).toBeNull()
    expect(nextRateLimitWait(rateLimited('1s', { quotaId: PER_DAY }), budget(), now)).toBeNull()

    expect([3, 2, 1].map((left) => nextRateLimitWait(rateLimited(), budget(left), now, () => 0.5))).toEqual([
      1000, 2000, 4000
    ])
    expect(nextRateLimitWait(rateLimited(), budget(), now, () => 0)).toBe(900)
    expect(nextRateLimitWait(rateLimited(), budget(1), now, () => 1)).toBe(4400)
  })
})
