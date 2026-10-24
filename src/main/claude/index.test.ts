import { describe, expect, it } from 'vitest'
import type { InterpretRequest } from '@shared/types'
import { fakeClaude, systemText } from './fakeClaude'
import { createClaudeService } from './index'

const reply = JSON.stringify({
  sentence: 'Open Safari.',
  intent: 'Open Safari',
  alternatives: [],
  confidence: 0.9,
  needs_confirmation: false,
  context_actions: []
})

describe('createClaudeService', () => {
  it('reads the current tool list on every interpret call', async () => {
    const fake = fakeClaude(reply, reply)
    let tools = [{ name: 'open_app', description: 'Open an app' }]
    const service = createClaudeService({ tools: () => tools, claude: fake.provider })
    const req: InterpretRequest = {
      tokens: ['OPEN', 'SAFARI'],
      sentence: 'open safari',
      mode: 'command',
      frontmost: null,
      gestures: []
    }

    expect((await service.interpret(req)).ok).toBe(true)
    tools = [...tools, { name: 'music_play', description: 'Play music' }]
    await service.interpret(req)

    expect(systemText(fake.calls[0])).not.toContain('music_play')
    expect(systemText(fake.calls[1])).toContain('- music_play: Play music')
  })

  it('routes spell suggestions through the same client', async () => {
    const fake = fakeClaude('{"suggestions":["Safari"]}')
    const service = createClaudeService({ tools: () => [], claude: fake.provider })
    expect(await service.spellSuggest({ letters: 'SAF', frontmost: null })).toEqual({ ok: true, value: ['Safari'] })
  })
})
