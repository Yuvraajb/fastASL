import { describe, expect, it } from 'vitest'
import type { InterpretRequest } from '@shared/types'
import { createLlmService } from './index'

const service = createLlmService({ tools: () => [], provider: { ok: true, value: 'mock' } })

const request = (patch: Partial<InterpretRequest>): InterpretRequest => ({
  tokens: [],
  sentence: '',
  mode: 'command',
  frontmost: null,
  gestures: [],
  ...patch
})

describe('LLM_PROVIDER=mock', () => {
  it('answers a command with a canned intent, through validation and sanitizing', async () => {
    const result = await service.interpret(request({ tokens: ['meeting', 'tomorrow'], sentence: 'Meeting tomorrow at 3 pm' }))
    expect(result).toEqual({
      ok: true,
      value: {
        sentence: 'Meeting tomorrow at 3pm.',
        intent: 'Schedule a meeting tomorrow at 3pm with the team',
        alternatives: [],
        confidence: 0.86,
        needs_confirmation: true,
        context_actions: ['Insert text', 'Send message', 'More options']
      }
    })
  })

  it('is deterministic and follows the request', async () => {
    const req = request({ tokens: ['play', 'music'], sentence: 'play music', intentPrefix: 'Open app' })
    const first = await service.interpret(req)
    expect(await service.interpret(req)).toEqual(first)
    expect(first).toMatchObject({ ok: true, value: { sentence: 'Play music.', intent: 'Open app: play music' } })

    // Outside Command mode, sanitizing drops the intent as for any provider.
    expect(await service.interpret(request({ tokens: ['hi'], sentence: 'hi', mode: 'dictation' }))).toMatchObject({
      ok: true,
      value: { sentence: 'Hi.', intent: null }
    })
  })

  it('offers a low-confidence question with alternatives', async () => {
    const result = await service.interpret(request({ tokens: ['what', 'time'], sentence: 'what time next meeting' }))
    expect(result).toMatchObject({ ok: true, value: { intent: null, confidence: 0.5 } })
  })

  it('spells, dropping the address the user did not spell an "@" for', async () => {
    expect(await service.spellSuggest({ letters: 'KRISH', frontmost: null })).toEqual({
      ok: true,
      value: ['Krish', 'krish.com']
    })
  })
})
