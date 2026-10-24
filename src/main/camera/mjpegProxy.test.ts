import dns from 'node:dns'
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startMjpegProxy, type MjpegProxy } from './mjpegProxy'

const BOUNDARY = 'frame'
const jpeg = (n: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`frame-${n}`), Buffer.from([0xff, 0xd9])])
const part = (n: number): Buffer => {
  const body = jpeg(n)
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`),
    body,
    Buffer.from('\r\n')
  ])
}

/** A fake ESP32-CAM: /stream emits multipart JPEG parts until the client leaves. */
class FakeCamera {
  server: Server
  port = 0
  streamsOpen = 0
  streamsClosed = 0
  private sockets = new Set<Socket>()

  constructor(private routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {}) {
    this.server = createServer((req, res) => {
      const route = this.routes[req.url ?? '']
      if (route) return route(req, res)
      if (req.url !== '/stream') return res.writeHead(404).end('nope')
      this.streamsOpen++
      res.writeHead(200, { 'content-type': `multipart/x-mixed-replace;boundary=${BOUNDARY}` })
      let n = 0
      const timer = setInterval(() => res.write(part(n++)), 10)
      res.write(part(n++))
      res.on('close', () => {
        clearInterval(timer)
        this.streamsClosed++
      })
    })
    this.server.on('connection', (s) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
  }

  url(path = '/stream'): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    return new Promise((r) => this.server.close(() => r()))
  }
}

interface Fetched {
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
}

/** GET `url`, collect at least `minBytes` (or the whole body), then hang up. */
function fetchBytes(url: string, minBytes = Infinity): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      const finish = (): void => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        size += c.length
        if (size >= minBytes) {
          finish()
          req.destroy()
        }
      })
      res.on('end', finish)
    })
    req.on('error', reject)
  })
}

const waitFor = async (check: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('startMjpegProxy', () => {
  let camera: FakeCamera
  let proxy: MjpegProxy

  beforeEach(async () => {
    camera = new FakeCamera({
      '/broken': (_req, res) => res.writeHead(500).end('boom'),
      '/silent': () => {
        /* never answers */
      },
      '/stall': (_req, res) => {
        res.writeHead(200, { 'content-type': `multipart/x-mixed-replace;boundary=${BOUNDARY}` })
        res.write(part(0)) // ...then nothing, like an ESP32 that fell off Wi-Fi
      },
      '/snapshot': (_req, res) => {
        const body = jpeg(7)
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) })
        res.end(body)
      }
    })
    await camera.listen()
    proxy = await startMjpegProxy({ timeoutMs: 300 })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await proxy.close()
    await camera.close()
  })

  it('binds to 127.0.0.1 and builds tokenized proxy URLs', () => {
    const url = new URL(proxy.urlFor('http://10.0.0.5:81/stream?x=1&y=2'))
    expect(url.hostname).toBe('127.0.0.1')
    expect(Number(url.port)).toBe(proxy.port)
    expect(url.searchParams.get('url')).toBe('http://10.0.0.5:81/stream?x=1&y=2')
    expect(url.searchParams.get('token')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('streams multipart frames through unchanged with CORS and no-store headers', async () => {
    const res = await fetchBytes(proxy.urlFor(camera.url()), part(0).length * 3)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe(`multipart/x-mixed-replace;boundary=${BOUNDARY}`)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['cache-control']).toBe('no-store')
    const expected = Buffer.concat([part(0), part(1), part(2)])
    expect(res.body.subarray(0, expected.length).equals(expected)).toBe(true)
  })

  it('closes the camera connection when the client disconnects', async () => {
    await fetchBytes(proxy.urlFor(camera.url()), 1)
    await waitFor(() => camera.streamsOpen === 1 && camera.streamsClosed === 1)
  })

  it('passes single JPEG responses through with their length', async () => {
    const res = await fetchBytes(proxy.urlFor(camera.url('/snapshot')))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['content-length']).toBe(String(jpeg(7).length))
    expect(res.body.equals(jpeg(7))).toBe(true)
  })

  it.each([
    ['file:///etc/passwd', 'Only http'],
    ['ftp://10.0.0.5/stream', 'Only http'],
    ['not a url', 'Invalid stream URL']
  ])('rejects %s with 400', async (target, message) => {
    const res = await fetchBytes(proxy.urlFor(target))
    expect(res.status).toBe(400)
    expect(res.body.toString()).toContain(message)
  })

  it('requires the per-launch token', async () => {
    const url = new URL(proxy.urlFor(camera.url()))
    url.searchParams.set('token', 'guess')
    expect((await fetchBytes(url.toString())).status).toBe(403)
    url.searchParams.delete('token')
    expect((await fetchBytes(url.toString())).status).toBe(403)
    expect(camera.streamsOpen).toBe(0)
  })

  it('returns 404 for other paths', async () => {
    expect((await fetchBytes(`http://127.0.0.1:${proxy.port}/other`)).status).toBe(404)
  })

  it('maps upstream HTTP errors to 502', async () => {
    const res = await fetchBytes(proxy.urlFor(camera.url('/broken')))
    expect(res.status).toBe(502)
    expect(res.body.toString()).toContain('HTTP 500')
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('maps unreachable cameras to 502', async () => {
    const dead = new FakeCamera()
    await dead.listen()
    const url = dead.url()
    await dead.close()
    const res = await fetchBytes(proxy.urlFor(url))
    expect(res.status).toBe(502)
    expect(res.body.toString()).toContain('ECONNREFUSED')
  })

  it('gives up on cameras that never answer', async () => {
    const started = Date.now()
    const res = await fetchBytes(proxy.urlFor(camera.url('/silent')))
    expect(res.status).toBe(502)
    expect(res.body.toString()).toContain('no data')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('gives up on cameras that never finish connecting', async () => {
    // A lookup that never answers keeps the socket in its connecting phase, like an
    // unplugged ESP32 whose IP drops the handshake, but deterministically.
    vi.spyOn(dns, 'lookup').mockImplementation((() => undefined) as unknown as typeof dns.lookup)
    const started = Date.now()
    const res = await fetchBytes(proxy.urlFor('http://esp32cam.local:81/stream'))
    expect(res.status).toBe(502)
    expect(res.body.toString()).toContain('no data')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('hangs up on a stream that stalls after it started', async () => {
    const closed = new Promise<Buffer>((resolve) => {
      get(proxy.urlFor(camera.url('/stall')), (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('close', () => resolve(Buffer.concat(chunks)))
      })
    })
    expect((await closed).equals(part(0))).toBe(true)
  })

  it('close() ends active streams', async () => {
    const res = new Promise<void>((resolve) => {
      get(proxy.urlFor(camera.url()), (r) => {
        r.on('data', () => undefined)
        r.on('close', resolve)
      })
    })
    await waitFor(() => camera.streamsOpen === 1)
    await proxy.close()
    await res
    await waitFor(() => camera.streamsClosed === 1)
  })
})
