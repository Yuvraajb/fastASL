import { describe, expect, it } from 'vitest'
import type { IdentifySignRequest } from '@shared/types'
import { fakeClaude, systemText } from './fakeClaude'
import {
  MAX_SIGN_FRAMES,
  SIGN_SYSTEM,
  SignReply,
  buildSignRequest,
  cleanGloss,
  identifySignWith,
  sanitizeSignGuess,
  signImages
} from './sign'
import { claudeSource } from './structured'

/** Three tiny base64 "JPEGs" (the transport never decodes them). */
const FRAMES = ['/9j/AAA=', '/9j/BBB=', '/9j/CCC=']
const request: IdentifySignRequest = {
  frames: FRAMES,
  motion: '1.2 s, one hand, on the signer\'s right, high in the frame.\nHand: open hand throughout. Moves down 1.4 hand lengths.',
  mode: 'command',
  known: ['MEETING', 'TOMORROW']
}
const guess = (candidates: { gloss: string; confidence: number; hands: number }[], is_sign = true): string =>
  JSON.stringify({ is_sign, candidates })

describe('SignReply (the identifySign JSON)', () => {
  it('takes up to 3 candidates', () => {
    const three = { is_sign: true, candidates: [1, 2, 3].map((i) => ({ gloss: `W${i}`, confidence: 0.1 * i, hands: 1 })) }
    expect(SignReply.safeParse(three).success).toBe(true)
    expect(SignReply.safeParse({ is_sign: false, candidates: [] }).success).toBe(true)
  })

  it('refuses a 4th candidate, a missing field or a wrong type', () => {
    const four = { is_sign: true, candidates: [1, 2, 3, 4].map((i) => ({ gloss: `W${i}`, confidence: 0.1, hands: 1 })) }
    expect(SignReply.safeParse(four).success).toBe(false)
    expect(SignReply.safeParse({ candidates: [] }).success).toBe(false)
    expect(SignReply.safeParse({ is_sign: 'yes', candidates: [] }).success).toBe(false)
    expect(SignReply.safeParse({ is_sign: true, candidates: [{ gloss: 'HI' }] }).success).toBe(false)
  })
})

describe('sanitizeSignGuess', () => {
  it('upper-cases glosses, drops duplicates and empties, sorts by confidence and clamps it to 0..1', () => {
    expect(
      sanitizeSignGuess({
        is_sign: true,
        candidates: [
          { gloss: 'thank you', confidence: 0.4, hands: 1 },
          { gloss: ' Hello! ', confidence: 1.7, hands: 1 },
          { gloss: 'HELLO', confidence: 0.3, hands: 1 }
        ]
      })
    ).toEqual({
      is_sign: true,
      candidates: [
        { gloss: 'HELLO', confidence: 1, hands: 1 },
        { gloss: 'THANK YOU', confidence: 0.4, hands: 1 }
      ]
    })
  })

  it('has no candidates when it is no sign, and is no sign without usable candidates', () => {
    expect(sanitizeSignGuess({ is_sign: false, candidates: [{ gloss: 'HELLO', confidence: 0.2, hands: 1 }] })).toEqual({
      is_sign: false,
      candidates: []
    })
    expect(sanitizeSignGuess({ is_sign: true, candidates: [{ gloss: '???', confidence: 0.9, hands: 1 }] })).toEqual({
      is_sign: false,
      candidates: []
    })
  })

  it('cleans a gloss to letters, digits, spaces, hyphens and apostrophes, and drops a sentence-length one', () => {
    expect(cleanGloss('e-mail')).toBe('E-MAIL')
    expect(cleanGloss("  don't  know. ")).toBe("DON'T KNOW")
    expect(cleanGloss('A'.repeat(40))).toBe('')
  })
})

describe('signImages and the request text', () => {
  it('sends JPEGs without the data: prefix, at most 8, and drops anything that is not base64', () => {
    const many = Array.from({ length: 10 }, (_, i) => `/9j/${i}A==`)
    expect(signImages(many)).toHaveLength(MAX_SIGN_FRAMES)
    expect(signImages(['data:image/jpeg;base64,/9j/AAA=', 'not base64!'])).toEqual([{ mimeType: 'image/jpeg', data: '/9j/AAA=' }])
  })

  it('describes the frames by count, never by content', () => {
    expect(JSON.parse(buildSignRequest(request))).toEqual({
      frames: 3,
      motion: request.motion,
      mode: 'command',
      known_signs: ['MEETING', 'TOMORROW']
    })
  })
})

describe('identifySign on Claude (fake transport)', () => {
  it('sends the frames as image blocks before the text, with the sign prompt and the strict schema', async () => {
    const fake = fakeClaude(guess([{ gloss: 'hello', confidence: 0.8, hands: 1 }, { gloss: 'hi', confidence: 0.5, hands: 1 }]))
    const res = await identifySignWith(request, claudeSource(fake.provider))
    expect(res).toEqual({
      ok: true,
      value: { is_sign: true, candidates: [{ gloss: 'HELLO', confidence: 0.8, hands: 1 }, { gloss: 'HI', confidence: 0.5, hands: 1 }] }
    })
    expect(fake.calls).toHaveLength(1)
    const params = fake.calls[0]
    expect(params.model).toBe('claude-sonnet-5-5')
    expect(params.max_tokens).toBe(512)
    expect(systemText(params)).toBe(SIGN_SYSTEM)
    const [turn] = params.messages
    expect(turn.role).toBe('user')
    expect(turn.content).toEqual([
      ...FRAMES.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
      { type: 'text', text: buildSignRequest(request) }
    ])
    const format = (params as unknown as { output_config: { format: { schema: { properties: object; required: string[] } } } })
      .output_config.format
    expect(format.schema.required).toEqual(['is_sign', 'candidates'])
  })

  it('retries once with text only after an unusable reply, keeping the images in the first turn', async () => {
    const fake = fakeClaude('not json', guess([{ gloss: 'THANK YOU', confidence: 0.9, hands: 1 }]))
    const res = await identifySignWith(request, claudeSource(fake.provider))
    expect(res).toMatchObject({ ok: true, value: { candidates: [{ gloss: 'THANK YOU' }] } })
    expect(fake.calls).toHaveLength(2)
    const retry = fake.calls[1].messages
    expect(retry).toHaveLength(3)
    expect(Array.isArray(retry[0].content) && retry[0].content.filter((b) => b.type === 'image')).toHaveLength(3)
    expect(retry[1].role).toBe('assistant')
    expect(typeof retry[2].content).toBe('string')
    expect(retry[2].content).toMatch(/^Your reply was unusable: it was not valid JSON/)
  })

  it('answers "not a sign" with no candidates', async () => {
    const fake = fakeClaude(guess([], false))
    expect(await identifySignWith(request, claudeSource(fake.provider))).toEqual({
      ok: true,
      value: { is_sign: false, candidates: [] }
    })
  })

  it('a missing key is a soft error, and nothing is sent', async () => {
    const res = await identifySignWith(request, claudeSource(() => ({ ok: false, error: 'Add ANTHROPIC_API_KEY to .env', missingKey: 'ANTHROPIC_API_KEY' })))
    expect(res).toEqual({ ok: false, error: 'Add ANTHROPIC_API_KEY to .env', missingKey: 'ANTHROPIC_API_KEY' })
  })

  it('a cancelled call answers "Cancelled"', async () => {
    const fake = fakeClaude(
      (signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    )
    const abort = new AbortController()
    const pending = identifySignWith(request, claudeSource(fake.provider), undefined, abort.signal)
    abort.abort()
    expect(await pending).toEqual({ ok: false, error: 'Cancelled' })
  })

  it('needs frames or a motion summary', async () => {
    const fake = fakeClaude()
    expect(await identifySignWith({ ...request, frames: [], motion: ' ' }, claudeSource(fake.provider))).toEqual({
      ok: false,
      error: 'Nothing to identify'
    })
    expect(fake.calls).toHaveLength(0)
  })
})
