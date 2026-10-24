import { describe, expect, it } from 'vitest'
import { fakeClaude, lastUserText, systemText } from './fakeClaude'
import { spellSuggest } from './spell'

describe('spellSuggest', () => {
  it('returns up to 3 cleaned suggestions', async () => {
    const fake = fakeClaude('{"suggestions":[" Sarah ","sarah","Sara","Sasha","Saran"]}')
    const result = await spellSuggest({ letters: 'SARA', frontmost: null }, fake.provider)
    expect(result).toEqual({ ok: true, value: ['Sarah', 'Sara', 'Sasha'] })
  })

  it('sends the letters and the frontmost window as context', async () => {
    const fake = fakeClaude('```json\n{"suggestions":["Sarah L","Sarah"]}\n```')
    const result = await spellSuggest(
      { letters: 'SARAHL', frontmost: { name: 'Mail', windowTitle: 'New Message' } },
      fake.provider
    )

    expect(result).toEqual({ ok: true, value: ['Sarah L', 'Sarah'] })
    expect(JSON.parse(lastUserText(fake.calls[0]))).toEqual({
      letters: 'SARAHL',
      frontmost_app: { name: 'Mail', bundle_id: null, window_title: 'New Message' }
    })
    expect(systemText(fake.calls[0])).toMatch(/never add surnames, extra words, email domains/)
  })

  it('drops email addresses the user did not spell an @ for', async () => {
    const fake = fakeClaude('{"suggestions":["sarah.lee@gmail.com","Sarah","Sara"]}')
    const result = await spellSuggest({ letters: 'SARAH', frontmost: { name: 'Mail' } }, fake.provider)
    expect(result).toEqual({ ok: true, value: ['Sarah', 'Sara'] })
  })

  it('keeps an address the user is spelling', async () => {
    const fake = fakeClaude('{"suggestions":["sarah@gmail.com"]}')
    const result = await spellSuggest({ letters: 'SARAH@GMA', frontmost: { name: 'Mail' } }, fake.provider)
    expect(result).toEqual({ ok: true, value: ['sarah@gmail.com'] })
  })

  it('skips the call when no letters were spelled', async () => {
    const fake = fakeClaude()
    expect(await spellSuggest({ letters: ' ', frontmost: null }, fake.provider)).toEqual({ ok: true, value: [] })
    expect(fake.calls).toHaveLength(0)
  })

  it('retries once, then fails softly', async () => {
    const recovered = fakeClaude('{"suggestions": [', '{"suggestions":["Bob"]}')
    const result1 = await spellSuggest({ letters: 'BOB', frontmost: null }, recovered.provider)
    expect(result1).toEqual({ ok: true, value: ['Bob'] })

    const broken = fakeClaude('{}', '{"suggestions":"Bob"}')
    const result2 = await spellSuggest({ letters: 'BOB', frontmost: null }, broken.provider)
    expect(result2.ok).toBe(false)
    expect(broken.calls).toHaveLength(2)
  })
})
