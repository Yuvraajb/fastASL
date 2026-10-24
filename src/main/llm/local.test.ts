import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { SignReply, identifySignWith } from '../claude/sign'
import {
  LOCAL_DEFAULT_MODEL,
  LOCAL_DEFAULT_URL,
  localConfig,
  localLlm,
  localSource,
  noVision,
  ollamaChat,
  ollamaShow,
  type LocalChat,
  type LocalShow,
  type OllamaChatRequest,
  type OllamaChatResponse
} from './local'

const Schema = z.object({ word: z.string(), score: z.number() })
const request = { system: 'SYS', user: 'USER', schema: Schema, maxTokens: 300 }
const cfg = { url: LOCAL_DEFAULT_URL, model: LOCAL_DEFAULT_MODEL }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

const answer = (content: string, done_reason = 'stop'): OllamaChatResponse => ({
  model: LOCAL_DEFAULT_MODEL,
  done: true,
  done_reason,
  message: { role: 'assistant', content }
})

/** ECONNREFUSED exactly as undici throws it. */
const refused = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })
})

describe('localConfig', () => {
  it('defaults to Ollama on this Mac with llama3.2', () => {
    expect(localConfig({})).toEqual({ url: 'http://127.0.0.1:11434', model: 'llama3.2' })
  })

  it('accepts host:port without a scheme and drops trailing slashes', () => {
    expect(localConfig({ LOCAL_LLM_URL: ' 192.168.1.9:11434/ ', LOCAL_LLM_MODEL: ' tinyllama ' })).toEqual({
      url: 'http://192.168.1.9:11434',
      model: 'tinyllama'
    })
  })
})

describe('local (Ollama) structured output', () => {
  it('posts a non-streaming /api/chat with the JSON schema as format and parses the reply', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, answer('{"word":"hello","score":0.5}'))
    )
    const llm = localLlm(ollamaChat(cfg.url, fetch as unknown as typeof globalThis.fetch), cfg)

    expect(await llm.ask(request)).toEqual({ ok: true, value: { word: 'hello', score: 0.5 } })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:11434/api/chat')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(init?.body)) as OllamaChatRequest
    expect(body).toMatchObject({
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USER' }
      ],
      stream: false,
      options: { temperature: 0, num_predict: 300 },
      think: false
    })
    expect(body.format).toMatchObject({ type: 'object', required: ['word', 'score'] })
  })

  it('retries once after a reply cut off at num_predict', async () => {
    const calls: OllamaChatRequest[] = []
    const replies = [answer('{"word":"hel', 'length'), answer('{"word":"hello","score":1}')]
    const chat: LocalChat = async (body) => {
      calls.push(body)
      return replies.shift()!
    }
    expect(await localLlm(chat, cfg).ask(request)).toEqual({ ok: true, value: { word: 'hello', score: 1 } })
    expect(calls).toHaveLength(2)
    expect(calls[1].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(calls[1].messages[3].content).toMatch(/cut off/)
  })

  it('says to start Ollama when nothing listens', async () => {
    const down: LocalChat = async () => {
      throw refused
    }
    expect(await localLlm(down, cfg).ask(request)).toEqual({
      ok: false,
      error: 'Start Ollama (ollama serve) or set LOCAL_LLM_URL'
    })
  })

  it('says which model to pull when it is missing', async () => {
    const fetch = async () => json(404, { error: "model 'llama3.2' not found" })
    const llm = localLlm(ollamaChat(cfg.url, fetch as unknown as typeof globalThis.fetch), cfg)
    expect(await llm.ask(request)).toEqual({ ok: false, error: 'Run: ollama pull llama3.2' })
  })

  it('tells a wrong server from a missing model', async () => {
    const fetch = async () => new Response('404 page not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    const url = 'http://127.0.0.1:11434/v1'
    const llm = localLlm(ollamaChat(url, fetch as unknown as typeof globalThis.fetch), { ...cfg, url })
    expect(await llm.ask(request)).toEqual({ ok: false, error: `No Ollama server at ${url}. Check LOCAL_LLM_URL in .env` })
  })

  it('localSource reads LOCAL_LLM_URL / LOCAL_LLM_MODEL on every call and needs no key', () => {
    const urls: string[] = []
    const source = localSource(
      (url) => {
        urls.push(url)
        return async () => answer('{}')
      },
      () => localConfig({ LOCAL_LLM_URL: 'localhost:9999' })
    )
    const model = source()
    expect(model.ok).toBe(true)
    expect(urls).toEqual(['http://localhost:9999'])
  })
})

describe('identifySign on Ollama', () => {
  const FRAMES = ['/9j/AAA=', '/9j/BBB=', '/9j/CCC=']
  const signRequest = { frames: FRAMES, motion: '0.9 s, one hand.', mode: 'command' as const, known: [] }
  const signJson = '{"is_sign":true,"candidates":[{"gloss":"hello","confidence":0.6,"hands":1}]}'
  const recording = (content: string) => {
    const calls: OllamaChatRequest[] = []
    const chat: LocalChat = async (body) => {
      calls.push(body)
      return answer(content)
    }
    return { chat, calls }
  }
  const showing = (capabilities?: string[]): LocalShow => async () => (capabilities ? { capabilities } : {})
  const source = (chat: LocalChat, show: LocalShow, model = 'llava') =>
    localSource(() => chat, () => ({ url: LOCAL_DEFAULT_URL, model }), () => show)

  it('a vision model gets the frames on the user message', async () => {
    const { chat, calls } = recording(signJson)
    expect(await identifySignWith(signRequest, source(chat, showing(['completion', 'vision'])))).toEqual({
      ok: true,
      value: { is_sign: true, candidates: [{ gloss: 'HELLO', confidence: 0.6, hands: 1 }] }
    })
    expect(calls[0].model).toBe('llava')
    expect(calls[0].messages[1]).toMatchObject({ role: 'user', images: FRAMES })
    expect(calls[0].format).toMatchObject({ required: ['is_sign', 'candidates'] })
  })

  it('a model without vision is a short error, and no frames are sent; Ollama is asked once per model', async () => {
    const { chat, calls } = recording(signJson)
    const show = vi.fn(showing(['completion']))
    const llm = source(chat, show, 'llama3.2')
    const error = { ok: false, error: "llama3.2 can't see images. Set LOCAL_LLM_MODEL to a vision model" }
    expect(await identifySignWith(signRequest, llm)).toEqual(error)
    expect(await identifySignWith(signRequest, llm)).toEqual(error)
    expect(show).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
  })

  it('an Ollama too old to list capabilities just gets the call, and its image error is mapped', async () => {
    const fetch = async () => json(400, { error: 'this model is missing data required for image input' })
    const llm = localLlm(ollamaChat(cfg.url, fetch as unknown as typeof globalThis.fetch), cfg, showing())
    const res = await llm.ask({
      system: 'S',
      user: '{}',
      images: [{ mimeType: 'image/jpeg', data: '/9j/AAA=' }],
      schema: SignReply,
      maxTokens: 300
    })
    expect(res).toEqual({ ok: false, error: noVision('llama3.2') })
  })

  it('asks /api/show for the model, and says to start Ollama when nothing listens', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { capabilities: ['completion', 'vision'] }))
    expect(await ollamaShow(cfg.url, fetch as unknown as typeof globalThis.fetch)('llava', new AbortController().signal)).toEqual({
      capabilities: ['completion', 'vision']
    })
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/show')
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model: 'llava' })

    const { chat, calls } = recording(signJson)
    const down: LocalShow = async () => {
      throw refused
    }
    expect(await identifySignWith(signRequest, source(chat, down))).toEqual({
      ok: false,
      error: 'Start Ollama (ollama serve) or set LOCAL_LLM_URL'
    })
    expect(calls).toHaveLength(0)
  })

  it('text-only calls never ask about vision', async () => {
    const show = vi.fn(showing(['completion']))
    const { chat } = recording('{"word":"hi","score":1}')
    expect(await localLlm(chat, cfg, show).ask(request)).toMatchObject({ ok: true })
    expect(show).not.toHaveBeenCalled()
  })
})
