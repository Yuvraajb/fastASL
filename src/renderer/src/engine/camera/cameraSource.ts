import type { CameraSource } from '@shared/types'

/** An open camera. `element` is what MediaPipe reads and what the Feed draws. */
export interface CameraHandle {
  element: HTMLVideoElement | HTMLCanvasElement
  readonly width: number
  readonly height: number
  kind: CameraSource['kind']
  /** Set when a camera that opened fine later dies (unplugged, stream dropped). */
  readonly error: string | null
  stop(): void
}

export const CAMERA_DENIED = 'Camera access denied — allow fastASL in System Settings › Privacy & Security › Camera'
export const NO_CAMERA = 'No camera found — connect one or pick an ESP32 stream in Settings › Camera source'
export const CAMERA_BUSY = "The camera couldn't start — another app may be using it"
export const CAMERA_DISCONNECTED = 'The camera was disconnected'
export const STREAM_UNREACHABLE = "Can't reach the ESP32 stream"
export const STREAM_NOT_MJPEG = "That URL isn't a camera stream — ESP32-CAM streams usually look like http://<ip>:81/stream"
export const STREAM_LOST = 'Lost the ESP32 stream'

/** Long enough for the proxy's 5s connect timeout to answer first. */
const STREAM_TIMEOUT_MS = 8000

/** User-facing message for a getUserMedia / play() failure. */
export function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return CAMERA_DENIED
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return NO_CAMERA
    default:
      return CAMERA_BUSY
  }
}

/** User-facing message for a failed MJPEG preflight, from the proxy's answer. */
export function streamErrorMessage(status: number, contentType: string | null, body: string): string | null {
  if (status === 400) return body.trim() || STREAM_UNREACHABLE
  if (status < 200 || status >= 300) return STREAM_UNREACHABLE
  const type = (contentType ?? '').toLowerCase()
  return type.startsWith('multipart/') || type.startsWith('image/') ? null : STREAM_NOT_MJPEG
}

/**
 * Cameras that show another app's picture. OBS Virtual Camera shows the caption camera window,
 * so opening it by default films fastASL's own output: a black loop with no hands in it.
 */
const VIRTUAL_CAMERA = /virtual|\bobs\b|camtwist|snap camera|mmhmm|\bndi\b/i
const BUILT_IN_CAMERA = /facetime|built-in/i

/** The camera to use when none was picked: the built-in one first, any other real one next, never a virtual one. */
export function pickDefaultCamera(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'label' | 'deviceId'>[]): string | undefined {
  const real = devices.filter((d) => d.kind === 'videoinput' && !VIRTUAL_CAMERA.test(d.label))
  return (real.find((d) => BUILT_IN_CAMERA.test(d.label)) ?? real[0])?.deviceId || undefined
}

export async function defaultCameraId(): Promise<string | undefined> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  return pickDefaultCamera(devices)
}

export function openCamera(source: CameraSource): Promise<CameraHandle> {
  return source.kind === 'builtin' ? openBuiltin(source.deviceId) : openMjpeg(source.url)
}

async function openBuiltin(chosen?: string): Promise<CameraHandle> {
  const deviceId = chosen ?? (await defaultCameraId())
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        // ideal, not exact: if the chosen camera is unplugged, any camera beats none.
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {})
      },
      audio: false
    })
  } catch (err) {
    throw new Error(cameraErrorMessage(err))
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  let error: string | null = null
  for (const track of stream.getVideoTracks()) {
    track.addEventListener('ended', () => (error = CAMERA_DISCONNECTED))
  }
  const stop = (): void => {
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }

  try {
    await video.play()
  } catch (err) {
    stop()
    throw new Error(cameraErrorMessage(err))
  }

  return {
    element: video,
    kind: 'builtin',
    get width() {
      return video.videoWidth
    },
    get height() {
      return video.videoHeight
    },
    get error() {
      return error
    },
    stop
  }
}

/**
 * The proxy answers with a short reason on failure, which an <img> can't read,
 * so ask it first with fetch() and hang up as soon as the headers arrive.
 */
async function preflight(src: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(src, { cache: 'no-store', signal: AbortSignal.timeout(STREAM_TIMEOUT_MS) })
  } catch {
    throw new Error(STREAM_UNREACHABLE)
  }
  const body = res.ok ? '' : await res.text().catch(() => '')
  await res.body?.cancel().catch(() => undefined)
  const message = streamErrorMessage(res.status, res.headers.get('content-type'), body)
  if (message) throw new Error(message)
}

function loadFirstFrame(img: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(), STREAM_TIMEOUT_MS)
    const fail = (): void => {
      clearTimeout(timer)
      img.onload = img.onerror = null
      img.src = ''
      reject(new Error(STREAM_UNREACHABLE))
    }
    img.onload = () => {
      clearTimeout(timer)
      img.onload = img.onerror = null
      resolve()
    }
    img.onerror = fail
    img.src = src
  })
}

async function openMjpeg(url: string): Promise<CameraHandle> {
  const src = await window.fastasl.getMjpegProxyUrl(url)
  await preflight(src)

  const img = new Image()
  // Must be set before src: without it the canvas is tainted and MediaPipe can't read it.
  img.crossOrigin = 'anonymous'
  await loadFirstFrame(img, src)

  // <img> fires `load` only for the first part of a multipart stream, so copy the
  // latest decoded frame on every animation frame instead.
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  let error: string | null = null
  let raf = 0
  const copy = (): void => {
    const { naturalWidth: w, naturalHeight: h } = img
    if (!w || !h) {
      // A multipart stream that breaks off (or that the proxy drops after a stall)
      // leaves the <img> blank without firing `error`.
      error = STREAM_LOST
      return
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.drawImage(img, 0, 0)
    raf = requestAnimationFrame(copy)
  }
  copy()

  return {
    element: canvas,
    kind: 'mjpeg',
    get width() {
      return canvas.width
    },
    get height() {
      return canvas.height
    },
    get error() {
      return error
    },
    stop() {
      cancelAnimationFrame(raf)
      // Clearing src aborts the request, so the proxy hangs up on the camera too.
      img.src = ''
    }
  }
}
