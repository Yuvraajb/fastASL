import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import type { InterpretRequest } from '@shared/types'
import { fakeClaude, lastUserText, systemText } from '../claude/fakeClaude'
import type { GenerateContent } from './gemini'
import { createLlmService } from './index'
import type { LocalChat, OllamaChatRequest } from './local'
import { parseLlmProvider } from './provider'

const tools = [{ name: 'calendar_create_event', description: 'Create a Calendar event' }]

const request: InterpretRequest = {
  tokens: ['MEETING', 'TOMORROW', 'TIME', '3'],
  sentence: 'meeting tomorrow time 3',
  mode: 'command',
  intentPrefix: 'Create event',
  frontmost: { name: 'Calendar', bundleId: 'com.apple.iCal', windowTitle: 'Week' },
  gestures: [{ name: 'Rock on', task: 'Play Motion Sickness' }]
}

const intentJson = JSON.stringify({
  sentence: 'Meeting tomorrow at 3.',
  intent: 'Create a calendar event called Meeting tomorrow at 3 PM',
  alternatives: [],
  confidence: 0.9,
  needs_confirmation: false,
  context_actions: ['Insert text']
})

/** generateContent that answers every call with `text`, recording the requests. */
function geminiAnswering(text: string) {
  const calls: Parameters<GenerateContent>[0][] = []
  const generate: GenerateContent = async (params) => {
    calls.push(params)
    return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] } as GenerateContentResponse
  }
  return { generate, calls }
}

/** An Ollama chat that answers every call with `content`, recording the requests. */
function ollamaAnswering(content: string) {
  const calls: OllamaChatRequest[] = []
  const chat: LocalChat = async (body) => {
    calls.push(body)
    return { model: body.model, done: true, done_reason: 'stop', message: { role: 'assistant', content } }
  }
  return { chat, calls }
}

describe('parseLlmProvider', () => {
  it('defaults to claude when unset or blank', () => {
    expect(parseLlmProvider(undefined)).toEqual({ ok: true, value: 'claude' })
    expect(parseLlmProvider('  ')).toEqual({ ok: true, value: 'claude' })
  })

  it('accepts the four providers, trimmed and in any case', () => {
    expect(parseLlmProvider('gemini')).toEqual({ ok: true, value: 'gemini' })
    expect(parseLlmProvider(' Gemini ')).toEqual({ ok: true, value: 'gemini' })
    expect(parseLlmProvider('LOCAL')).toEqual({ ok: true, value: 'local' })
    expect(parseLlmProvider('mock')).toEqual({ ok: true, value: 'mock' })
    expect(parseLlmProvider('Claude')).toEqual({ ok: true, value: 'claude' })
  })

  it('names an unknown value and the valid ones', () => {
    expect(parseLlmProvider(' openai ')).toEqual({
      ok: false,
      error: 'Unknown LLM_PROVIDER "openai": use claude, gemini, local, mock or droid'
    })
  })
})

describe('createLlmService', () => {
  const original = process.env.GEMINI_API_KEY
  afterEach(() => {
    if (original === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = original
  })

  it('sends every provider the same prompt and request as Claude', async () => {
    const claude = fakeClaude(intentJson, '{"suggestions":["Krish"]}')
    const gemini = geminiAnswering(intentJson)
    const local = ollamaAnswering(intentJson)
    const service = (provider: 'claude' | 'gemini' | 'local') =>
      createLlmService({
        tools: () => tools,
        provider: { ok: true, value: provider },
        overrides: {
          claude: claude.provider,
          gemini: () => ({ ok: true, value: gemini.generate }),
          localChat: () => local.chat
        }
      })

    await service('claude').interpret(request)
    await service('gemini').interpret(request)
    await service('local').interpret(request)

    const system = systemText(claude.calls[0])
    const user = lastUserText(claude.calls[0])
    expect(system).toContain('- calendar_create_event: Create a Calendar event')
    expect(JSON.parse(user)).toMatchObject({ intent_prefix: 'Create event', saved_gestures: request.gestures })

    expect(gemini.calls[0].config?.systemInstruction).toBe(system)
    expect(gemini.calls[0].contents).toEqual([{ role: 'user', parts: [{ text: user }] }])
    expect(local.calls[0].messages).toEqual([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ])
    // Claude keeps its caps; the others answer within ~300 tokens.
    expect(claude.calls[0].max_tokens).toBe(1024)
    expect(gemini.calls[0].config?.maxOutputTokens).toBe(300)
    expect(local.calls[0].options.num_predict).toBe(300)
  })

  it('validates and sanitizes every provider the same way', async () => {
    const sloppy = JSON.stringify({
      sentence: '  Meeting   tomorrow at 3. ',
      intent: 'Schedule a meeting tomorrow at 3 PM',
      alternatives: ['Schedule a meeting tomorrow at 3 PM', 'Open Calendar', 'open calendar'],
      confidence: 1.4,
      needs_confirmation: false,
      context_actions: []
    })
    const gemini = geminiAnswering(sloppy)
    const service = createLlmService({
      tools: () => tools,
      provider: { ok: true, value: 'gemini' },
      overrides: { gemini: () => ({ ok: true, value: gemini.generate }) }
    })
    expect(await service.interpret(request)).toEqual({
      ok: true,
      value: {
        sentence: 'Meeting tomorrow at 3.',
        intent: 'Schedule a meeting tomorrow at 3 PM',
        alternatives: ['Open Calendar'],
        confidence: 1,
        needs_confirmation: true, // "Schedule" is a side-effect verb
        context_actions: []
      }
    })
  })

  it('gemini serves spelling too, with the spelling schema and the "@" filter', async () => {
    const gemini = geminiAnswering('{"suggestions":["Krish","krish@gmail.com","Krishna"]}')
    const service = createLlmService({
      tools: () => [],
      provider: { ok: true, value: 'gemini' },
      overrides: { gemini: () => ({ ok: true, value: gemini.generate }) }
    })
    expect(await service.spellSuggest({ letters: 'KRISH', frontmost: null })).toEqual({
      ok: true,
      value: ['Krish', 'Krishna']
    })
    expect(gemini.calls[0].config?.responseSchema).toMatchObject({ required: ['suggestions'] })
  })

  it('without GEMINI_API_KEY, gemini says which key to add and never calls out', async () => {
    process.env.GEMINI_API_KEY = ''
    const service = createLlmService({ tools: () => tools, provider: { ok: true, value: 'gemini' } })
    const missing = { ok: false, error: 'Add GEMINI_API_KEY to .env', missingKey: 'GEMINI_API_KEY' }
    expect(await service.interpret(request)).toEqual(missing)
    expect(await service.spellSuggest({ letters: 'KR', frontmost: null })).toEqual(missing)
    // Nothing to do still answers first, as on Claude.
    expect(await service.spellSuggest({ letters: ' ', frontmost: null })).toEqual({ ok: true, value: [] })
  })

  it('an unknown LLM_PROVIDER answers both calls with its error, falling back to nothing', async () => {
    const claude = fakeClaude()
    const service = createLlmService({
      tools: () => tools,
      provider: parseLlmProvider('gpt'),
      overrides: { claude: claude.provider }
    })
    const error = { ok: false, error: 'Unknown LLM_PROVIDER "gpt": use claude, gemini, local, mock or droid' }
    expect(await service.interpret(request)).toEqual(error)
    expect(await service.spellSuggest({ letters: 'KR', frontmost: null })).toEqual(error)
    expect(claude.calls).toHaveLength(0)
  })

  it('passes the status listener down to the provider', async () => {
    const statuses: string[] = []
    let calls = 0
    const generate: GenerateContent = async () => {
      calls++
      if (calls === 1) {
        const { ApiError } = await import('@google/genai')
        throw new ApiError({
          status: 429,
          message: JSON.stringify({
            error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }] }
          })
        })
      }
      return { candidates: [{ content: { role: 'model', parts: [{ text: intentJson }] }, finishReason: 'STOP' }] } as GenerateContentResponse
    }
    const service = createLlmService({
      tools: () => tools,
      provider: { ok: true, value: 'gemini' },
      overrides: { gemini: () => ({ ok: true, value: generate }) }
    })
    const result = await service.interpret(request, (s) => statuses.push(s))
    expect(result.ok).toBe(true)
    expect(statuses).toEqual(['Rate limited, retrying...'])
  })

  it('identifySign: the same sign prompt, images and schema on every provider; Gemini guesses on its sign model', async () => {
    const signJson = '{"is_sign":true,"candidates":[{"gloss":"HELLO","confidence":0.7,"hands":1}]}'
    const claude = fakeClaude(signJson)
    const gemini = geminiAnswering(signJson)
    const local = ollamaAnswering(signJson)
    const service = (provider: 'claude' | 'gemini' | 'local') =>
      createLlmService({
        tools: () => tools,
        provider: { ok: true, value: provider },
        overrides: {
          claude: claude.provider,
          gemini: () => ({ ok: true, value: gemini.generate }),
          geminiModel: () => 'gemini-3.5-flash-lite',
          geminiSignModel: () => 'gemini-3.5-flash',
          localChat: () => local.chat,
          localShow: () => async () => ({ capabilities: ['completion', 'vision'] })
        }
      })
    const req = { frames: ['/9j/AAA=', '/9j/BBB=', '/9j/CCC='], motion: '1.0 s, one hand.', mode: 'command' as const, known: ['YES'] }
    const answer = { ok: true, value: { is_sign: true, candidates: [{ gloss: 'HELLO', confidence: 0.7, hands: 1 }] } }
    expect(await service('claude').identifySign(req)).toEqual(answer)
    expect(await service('gemini').identifySign(req)).toEqual(answer)
    expect(await service('local').identifySign(req)).toEqual(answer)
    // Intent stays on the text model (this answer is no intent, so it also gets the corrective retry).
    await service('gemini').interpret(request)

    const system = systemText(claude.calls[0])
    expect(system).toMatch(/^You identify American Sign Language/)
    expect(gemini.calls[0].config?.systemInstruction).toBe(system)
    expect(local.calls[0].messages[0]).toEqual({ role: 'system', content: system })
    const text = (claude.calls[0].messages[0].content as { type: string; text?: string }[]).at(-1)?.text
    expect(gemini.calls[0].contents).toEqual([
      { role: 'user', parts: [...req.frames.map((data) => ({ inlineData: { mimeType: 'image/jpeg', data } })), { text }] }
    ])
    expect(local.calls[0].messages[1]).toEqual({ role: 'user', content: text, images: req.frames })
    expect(gemini.calls.map((c) => c.model)).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'])
  })

  it('identifySign: without the key or with an unknown provider, nothing is sent', async () => {
    process.env.GEMINI_API_KEY = ''
    const req = { frames: ['/9j/AAA='], motion: '1.0 s.', mode: 'command' as const, known: [] }
    expect(await createLlmService({ tools: () => [], provider: { ok: true, value: 'gemini' } }).identifySign(req)).toEqual({
      ok: false,
      error: 'Add GEMINI_API_KEY to .env',
      missingKey: 'GEMINI_API_KEY'
    })
    const claude = fakeClaude()
    const unknown = createLlmService({ tools: () => [], provider: parseLlmProvider('gpt'), overrides: { claude: claude.provider } })
    expect(await unknown.identifySign(req)).toMatchObject({ ok: false, error: expect.stringMatching(/^Unknown LLM_PROVIDER/) })
    expect(claude.calls).toHaveLength(0)
  })

  it('identifySign: a sign model Gemini lacks (404) or has no quota for says GEMINI_SIGN_MODEL, and never falls back', async () => {
    const { ApiError } = await import('@google/genai')
    const models: string[] = []
    const failing = (status: number, body: object): GenerateContent => async (params) => {
      models.push(params.model)
      throw new ApiError({ status, message: JSON.stringify(body) })
    }
    const req = { frames: ['/9j/AAA=', '/9j/BBB=', '/9j/CCC='], motion: '1.0 s.', mode: 'command' as const, known: [] }
    const service = (generate: GenerateContent) =>
      createLlmService({
        tools: () => [],
        provider: { ok: true, value: 'gemini' },
        overrides: { gemini: () => ({ ok: true, value: generate }), geminiSignModel: () => 'gemini-nope' }
      })
    expect(await service(failing(404, { error: { code: 404, message: 'not found' } })).identifySign(req)).toEqual({
      ok: false,
      error: 'Gemini has no model "gemini-nope". Check GEMINI_SIGN_MODEL in .env'
    })
    const noQuota = {
      error: {
        code: 429,
        message: 'limit: 0',
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'PerMinute', quotaValue: '0' }] }]
      }
    }
    expect(await service(failing(429, noQuota)).identifySign(req)).toEqual({
      ok: false,
      error: 'Gemini has no quota for gemini-nope on this key. Change GEMINI_SIGN_MODEL in .env'
    })
    expect(models).toEqual(['gemini-nope', 'gemini-nope'])
  })
})

describe('LLM_PROVIDER=droid', () => {
  it('sends the signed glosses to the agent as they are, with no model call', async () => {
    const llm = createLlmService({ tools: () => [], provider: { ok: true, value: 'droid' } })
    const res = await llm.interpret({ tokens: ['tomorrow', 'meeting', 'what', 'time'], sentence: '', mode: 'command', frontmost: null, gestures: [] })
    expect(res).toMatchObject({ ok: true, value: { sentence: 'Tomorrow meeting what time', intent: '(ASL glosses, in signing order) tomorrow meeting what time' } })
    expect(await llm.spellSuggest({ letters: 'KRIS', frontmost: null })).toEqual({ ok: true, value: [] })
    expect((await llm.identifySign({ frames: [], motion: '', mode: 'command', known: [] })).ok).toBe(false)
  })
})

describe('joinLetters (droid passthrough)', () => {
  it('joins a run of spelled letters into one word, so CALL D W reads "call DW"', async () => {
    const { joinLetters } = await import('./index')
    expect(joinLetters(['call', 'D', 'W'])).toBe('call DW')
    expect(joinLetters(['meeting', 'D', 'W', 'tomorrow'])).toBe('meeting DW tomorrow')
    expect(joinLetters(['hello', 'friend'])).toBe('hello friend')
  })
})
