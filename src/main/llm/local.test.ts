import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  LOCAL_DEFAULT_MODEL,
  LOCAL_DEFAULT_URL,
  localConfig,
  localLlm,
  localSource,
  ollamaChat,
  type LocalChat,
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
