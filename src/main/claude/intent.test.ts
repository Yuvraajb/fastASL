import { describe, expect, it } from 'vitest'
import type { InterpretRequest } from '@shared/types'
import { fakeClaude, lastUserText, systemText } from './fakeClaude'
import { interpret, sanitizeIntent } from './intent'

const tools = [
  { name: 'calendar_create_event', description: 'Create a Calendar event' },
  { name: 'mail_send', description: 'Send an email with Mail' }
]

const request = (patch: Partial<InterpretRequest> = {}): InterpretRequest => ({
  tokens: ['MEETING', 'TOMORROW', 'TIME', '3'],
  sentence: 'meeting tomorrow time 3',
  mode: 'command',
  frontmost: null,
  gestures: [],
  ...patch
})

const reply = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    sentence: 'I have a meeting tomorrow at 3.',
    intent: 'Create a calendar event called Meeting tomorrow at 3 PM',
    alternatives: ['Remind me about the meeting tomorrow at 3 PM'],
    confidence: 0.82,
    needs_confirmation: true,
    context_actions: ['Insert text', 'More options'],
    ...patch
  })

describe('interpret', () => {
  it('returns the interpreted sentence and intent', async () => {
    const fake = fakeClaude(reply())
    const result = await interpret(request(), { tools }, fake.provider)

    expect(result).toEqual({
      ok: true,
      value: {
        sentence: 'I have a meeting tomorrow at 3.',
        intent: 'Create a calendar event called Meeting tomorrow at 3 PM',
        alternatives: ['Remind me about the meeting tomorrow at 3 PM'],
        confidence: 0.82,
        needs_confirmation: true,
        context_actions: ['Insert text', 'More options']
      }
    })
  })

  it('puts the tools in the system prompt and the request context in the user turn', async () => {
    const fake = fakeClaude(reply())
    await interpret(
      request({
        tokens: ['TOMORROW', '10AM', 'TEAM'],
        intentPrefix: 'Create event',
        frontmost: { name: 'Mail', bundleId: 'com.apple.mail', windowTitle: 'New Message' },
        gestures: [{ name: 'Rock on', task: 'Play Motion Sickness' }]
      }),
      { tools },
      fake.provider
    )

    const system = systemText(fake.calls[0])
    expect(system).toContain('- calendar_create_event: Create a Calendar event')
    expect(system).toContain('- mail_send: Send an email with Mail')

    const user = JSON.parse(lastUserText(fake.calls[0]))
    expect(user).toEqual({
      mode: 'command',
      tokens: ['TOMORROW', '10AM', 'TEAM'],
      draft: 'meeting tomorrow time 3',
      intent_prefix: 'Create event',
      frontmost_app: { name: 'Mail', bundle_id: 'com.apple.mail', window_title: 'New Message' },
      saved_gestures: [{ name: 'Rock on', task: 'Play Motion Sickness' }]
    })
  })

  it('tolerates a fenced reply and recovers from invalid JSON with one retry', async () => {
    const fenced = fakeClaude('```json\n' + reply() + '\n```')
    expect((await interpret(request(), { tools }, fenced.provider)).ok).toBe(true)

    const retried = fakeClaude('{"sentence": "I have', reply())
    const result = await interpret(request(), { tools }, retried.provider)
    expect(result.ok).toBe(true)
    expect(retried.calls).toHaveLength(2)
  })

  it('fails softly when the retry is also invalid', async () => {
    const fake = fakeClaude('not json', '{"sentence": 3}')
    const result = await interpret(request(), { tools }, fake.provider)
    expect(result.ok).toBe(false)
  })

  it('passes a missing key straight through', async () => {
    const result = await interpret(request(), { tools }, () => ({
      ok: false,
      error: 'Add ANTHROPIC_API_KEY to .env',
      missingKey: 'ANTHROPIC_API_KEY'
    }))
    expect(result).toEqual({ ok: false, error: 'Add ANTHROPIC_API_KEY to .env', missingKey: 'ANTHROPIC_API_KEY' })
  })

  it('does not call Claude when nothing was signed', async () => {
    const fake = fakeClaude()
    const result = await interpret(request({ tokens: [], sentence: '  ' }), { tools }, fake.provider)
    expect(result.ok).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('sanitizeIntent', () => {
  const raw = JSON.parse(reply()) as Parameters<typeof sanitizeIntent>[0]

  it('clamps confidence into 0..1', () => {
    expect(sanitizeIntent({ ...raw, confidence: 1.7 }, request()).confidence).toBe(1)
    expect(sanitizeIntent({ ...raw, confidence: -0.3 }, request()).confidence).toBe(0)
  })

  it('trims, dedupes and caps the lists at 3', () => {
    const result = sanitizeIntent(
      {
        ...raw,
        intent: 'Open Mail',
        alternatives: ['  open mail ', 'Open Notes', 'open notes', '', 'Open Safari', 'Open Music', 'Open Maps'],
        context_actions: ['Insert text', 'insert  text', 'Send message', ' ', 'More options', 'Copy']
      },
      request()
    )
    expect(result.alternatives).toEqual(['Open Notes', 'Open Safari', 'Open Music'])
    expect(result.context_actions).toEqual(['Insert text', 'Send message', 'More options'])
  })

  it('drops the intent outside command mode', () => {
    const result = sanitizeIntent(raw, request({ mode: 'dictation' }))
    expect(result.intent).toBeNull()
    expect(result.needs_confirmation).toBe(false)
  })

  it('treats a blank intent as null', () => {
    expect(sanitizeIntent({ ...raw, intent: '   ' }, request()).intent).toBeNull()
  })

  const confirms = (intent: string, needs_confirmation = false): boolean =>
    sanitizeIntent({ ...raw, intent, needs_confirmation }, request()).needs_confirmation

  it.each([
    'Send a message to Mom saying hi',
    'Email Sarah the report',
    'Text Mom that I am running late',
    'Message John: see you soon',
    'Add a dentist appointment on Friday at 2 PM to Calendar',
    'Make a new event called Standup tomorrow',
    'Open Mail and send Sarah the report',
    'Find the old drafts, then delete them',
    'Please call Dad'
  ])('requires confirmation when a clause starts with a side-effect verb: %s', (intent) => {
    expect(confirms(intent)).toBe(true)
  })

  it.each([
    'Open Safari',
    'Play Post Malone on Spotify',
    'Search the web for how to share my screen',
    'Find emails from John about the invite'
  ])('leaves confirmation to the model when no clause starts with one: %s', (intent) => {
    expect(confirms(intent)).toBe(false)
  })

  it("never lowers the model's request for confirmation", () => {
    expect(confirms('Open Safari', true)).toBe(true)
  })

  it('falls back to the draft when the sentence is blank', () => {
    expect(sanitizeIntent({ ...raw, sentence: ' ' }, request()).sentence).toBe('meeting tomorrow time 3')
  })
})
