import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { pipeline } from 'node:stream'

/**
 * Local CORS proxy for MJPEG cameras (ESP32-CAM...). The renderer can only feed
 * an <img> to a canvas / MediaPipe when the response carries
 * Access-Control-Allow-Origin, which embedded cameras never send.
 */
export interface MjpegProxy {
  port: number
  /** Proxied URL for `streamUrl`, safe to use as an <img crossOrigin="anonymous"> src. */
  urlFor(streamUrl: string): string
  close(): Promise<void>
}

export interface MjpegProxyOptions {
  /**
   * Give up when the camera sends nothing for this long (ms): covers both the
   * connect timeout and a stream that stalls (Wi-Fi drop leaves the socket open).
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  })
  res.end(text)
}

function parseTarget(raw: string | null): URL | string {
  if (!raw) return 'Missing url parameter'
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return 'Invalid stream URL'
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'Only http:// and https:// streams are supported'
  return target
}

export function startMjpegProxy(options: MjpegProxyOptions = {}): Promise<MjpegProxy> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // The server is reachable by any local process (and any web page via fetch), so
  // every URL carries a per-launch secret; without it this would be an open relay.
  const token = randomBytes(16).toString('hex')
  const upstreams = new Set<ClientRequest>()

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mjpeg') return sendText(res, 404, 'Not found')
    if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed')
    if (url.searchParams.get('token') !== token) return sendText(res, 403, 'Forbidden')
    const target = parseTarget(url.searchParams.get('url'))
    if (typeof target === 'string') return sendText(res, 400, target)

    const request = target.protocol === 'https:' ? httpsRequest : httpRequest
    // agent: false — a long-lived stream should own its socket, never sit in a pool.
    // The timeout must be a request option: it arms the socket's idle timer before
    // connect (DNS + handshake), whereas req.setTimeout() only starts after 'connect',
    // leaving an unplugged camera to hang until the OS gives up (~75s).
    const upstream = request(target, { method: 'GET', agent: false, timeout: timeoutMs, headers: { accept: '*/*' } })
    upstreams.add(upstream)

    // Also fires on a stream that stalls; ending the response makes the renderer's
    // <img> go blank, which it reports as a lost stream and reconnects.
    upstream.on('timeout', () => {
      upstream.destroy(new Error(`no data for ${Math.round(timeoutMs / 1000)}s`))
    })

    // Client went away (img src changed, window reloaded): drop the camera connection
    // too. ESP32-CAM firmware serves a single stream client at a time.
    res.on('close', () => {
      upstream.destroy()
      upstreams.delete(upstream)
    })

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      sendText(res, 502, `Can't reach the stream: ${err.code ?? err.message}`)
    })

    upstream.on('response', (up) => {
      const status = up.statusCode ?? 502
      if (status < 200 || status >= 300) {
        up.resume()
        return sendText(res, 502, `Stream answered HTTP ${status}`)
      }
      const headers: Record<string, string> = {
        'content-type': up.headers['content-type'] ?? 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store'
      }
      if (up.headers['content-length']) headers['content-length'] = up.headers['content-length']
      res.writeHead(200, headers)
      pipeline(up, res, () => upstream.destroy())
    })

    upstream.end()
  }

  const server = createServer(handle)

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        urlFor: (streamUrl) =>
          `http://127.0.0.1:${port}/mjpeg?token=${token}&url=${encodeURIComponent(streamUrl)}`,
        close: () =>
          new Promise<void>((done) => {
            for (const upstream of upstreams) upstream.destroy()
            upstreams.clear()
            server.close(() => done())
            server.closeAllConnections()
          })
      })
    })
  })
}
