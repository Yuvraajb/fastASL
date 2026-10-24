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
      error: 'Unknown LLM_PROVIDER "openai": use claude, gemini, local or mock'
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
    const error = { ok: false, error: 'Unknown LLM_PROVIDER "gpt": use claude, gemini, local or mock' }
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
})
