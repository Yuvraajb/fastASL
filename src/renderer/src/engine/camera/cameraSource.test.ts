import { describe, expect, it } from 'vitest'
import {
  CAMERA_BUSY,
  CAMERA_DENIED,
  NO_CAMERA,
  STREAM_NOT_MJPEG,
  STREAM_UNREACHABLE,
  cameraErrorMessage,
  streamErrorMessage,
  isVirtualCamera,
  pickBuiltinCamera
} from './cameraSource'

describe('cameraErrorMessage', () => {
  it.each([
    ['NotAllowedError', CAMERA_DENIED],
    ['SecurityError', CAMERA_DENIED],
    ['NotFoundError', NO_CAMERA],
    ['OverconstrainedError', NO_CAMERA],
    ['NotReadableError', CAMERA_BUSY],
    ['AbortError', CAMERA_BUSY]
  ])('maps %s to a user-facing message', (name, message) => {
    expect(cameraErrorMessage(new DOMException('raw browser text', name))).toBe(message)
  })

  it('points denied users at the macOS privacy settings', () => {
    expect(CAMERA_DENIED).toContain('System Settings › Privacy & Security › Camera')
  })

  it('handles non-error values', () => {
    expect(cameraErrorMessage(undefined)).toBe(CAMERA_BUSY)
    expect(cameraErrorMessage('boom')).toBe(CAMERA_BUSY)
  })
})

describe('streamErrorMessage', () => {
  it('accepts MJPEG streams and single JPEGs', () => {
    expect(streamErrorMessage(200, 'multipart/x-mixed-replace;boundary=123456789000000000000987654321', '')).toBeNull()
    expect(streamErrorMessage(200, 'image/jpeg', '')).toBeNull()
  })

  it('flags URLs that point at a web page instead of the stream', () => {
    expect(streamErrorMessage(200, 'text/html', '')).toBe(STREAM_NOT_MJPEG)
    expect(streamErrorMessage(200, null, '')).toBe(STREAM_NOT_MJPEG)
  })

  it('reports unreachable cameras', () => {
    expect(streamErrorMessage(502, 'text/plain', "Can't reach the stream: EHOSTUNREACH")).toBe(STREAM_UNREACHABLE)
  })

  it('passes the proxy explanation through for bad URLs', () => {
    expect(streamErrorMessage(400, 'text/plain', 'Only http:// and https:// streams are supported\n')).toBe(
      'Only http:// and https:// streams are supported'
    )
  })
})

describe('choosing the built-in camera', () => {
  const cam = (label: string, deviceId = label): Pick<MediaDeviceInfo, 'kind' | 'label' | 'deviceId'> => ({ kind: 'videoinput', label, deviceId })

  it('knows software cameras by name', () => {
    expect(isVirtualCamera('OBS Virtual Camera')).toBe(true)
    expect(isVirtualCamera('FaceTime HD Camera')).toBe(false)
    expect(isVirtualCamera('')).toBe(false)
  })

  it('takes the built-in camera over OBS, even when OBS is listed first', () => {
    expect(pickBuiltinCamera([cam('OBS Virtual Camera', 'obs'), cam('FaceTime HD Camera', 'mac')])).toBe('mac')
    expect(pickBuiltinCamera([cam('Logitech C920'), cam('OBS Virtual Camera')])).toBe('Logitech C920')
  })

  it('has no answer with only virtual cameras, no names or no cameras', () => {
    expect(pickBuiltinCamera([cam('OBS Virtual Camera')])).toBeUndefined()
    expect(pickBuiltinCamera([cam('')])).toBeUndefined()
    expect(pickBuiltinCamera([])).toBeUndefined()
  })
})
