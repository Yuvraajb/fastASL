#!/usr/bin/env node
// Dev stand-in for an ESP32-CAM: serves http://127.0.0.1:8081/stream as
// multipart/x-mixed-replace JPEG frames, fed by ffmpeg.
//
//   node scripts/mock-mjpeg.mjs              Mac camera (avfoundation device 0)
//   node scripts/mock-mjpeg.mjs --test       generated test pattern, no camera needed
//   options: --port 8081  --device 0
//
// Also serves /capture (latest single JPEG), like the ESP32 CameraWebServer.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    port: { type: 'string', default: '8081' },
    device: { type: 'string', default: '0' }
  }
})

const HOST = '127.0.0.1'
const PORT = Number(args.port)
const BOUNDARY = 'frame'
const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])
const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')

const input = args.test
  ? ['-re', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=15']
  : ['-f', 'avfoundation', '-framerate', '30', '-video_size', '1280x720', '-i', args.device]
const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, '-an', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-']

const log = (msg) => console.log(`[mock-mjpeg] ${msg}`)

/** @type {Set<{ res: import('node:http').ServerResponse, busy: boolean }>} */
const clients = new Set()
let latest = null
let frames = 0

function broadcast(jpeg) {
  latest = jpeg
  frames++
  const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`)
  for (const client of clients) {
    // A slow client skips frames instead of buffering them, like a real camera.
    if (client.busy) continue
    client.res.write(header)
    client.res.write(jpeg)
    if (!client.res.write('\r\n')) {
      client.busy = true
      client.res.once('drain', () => (client.busy = false))
    }
  }
}

// ffmpeg writes JPEGs back to back; split them on start/end-of-image markers.
let pending = Buffer.alloc(0)
let scanFrom = 0
function onData(chunk) {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
  for (;;) {
    const start = pending.indexOf(SOI)
    if (start < 0) {
      pending = Buffer.alloc(0)
      scanFrom = 0
      return
    }
    const end = pending.indexOf(EOI, Math.max(start + 2, scanFrom))
    if (end < 0) {
      pending = pending.subarray(start)
      scanFrom = Math.max(0, pending.length - 1)
      return
    }
    broadcast(pending.subarray(start, end + 2))
    pending = pending.subarray(end + 2)
    scanFrom = 0
  }
}

const ffmpeg = spawn(FFMPEG, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
ffmpeg.stdout.on('data', onData)
ffmpeg.stderr.on('data', (d) => process.stderr.write(`[ffmpeg] ${d}`))
ffmpeg.on('error', (err) => {
  console.error(`[mock-mjpeg] could not start ffmpeg (${FFMPEG}): ${err.message}. Install it with: brew install ffmpeg`)
  process.exit(1)
})
ffmpeg.on('exit', (code, signal) => {
  if (shuttingDown) return
  console.error(`[mock-mjpeg] ffmpeg exited (${signal ?? code}).`)
  if (!args.test) {
    console.error('[mock-mjpeg] If the camera failed to open, allow your terminal app in System Settings › Privacy & Security › Camera, or use --test.')
  }
  process.exit(1)
})

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', `http://${HOST}`).pathname
  if (path === '/stream') {
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace;boundary=${BOUNDARY}`,
      'cache-control': 'no-store',
      connection: 'close'
    })
    const client = { res, busy: false }
    clients.add(client)
    log(`client connected (${clients.size} watching)`)
    res.on('close', () => {
      clients.delete(client)
      log(`client left (${clients.size} watching)`)
    })
    return
  }
  if (path === '/capture') {
    if (!latest) return res.writeHead(503, { 'content-type': 'text/plain' }).end('No frame yet')
    return res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': latest.length }).end(latest)
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end(`Mock ESP32-CAM. Stream: http://${HOST}:${PORT}/stream\n`)
})

server.on('error', (err) => {
  console.error(`[mock-mjpeg] ${err.code === 'EADDRINUSE' ? `port ${PORT} is already in use (try --port)` : err.message}`)
  ffmpeg.kill()
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  log(`streaming ${args.test ? 'a test pattern' : `camera ${args.device}`} at http://${HOST}:${PORT}/stream`)
})

const stats = setInterval(() => {
  if (clients.size) log(`${(frames / 5).toFixed(1)} fps to ${clients.size} client(s)`)
  frames = 0
}, 5000)

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(stats)
  ffmpeg.kill('SIGTERM')
  for (const { res } of clients) res.destroy()
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
