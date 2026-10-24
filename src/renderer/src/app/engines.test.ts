import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraSource } from '@shared/types'
import { startEngines, subscribeFrames } from './engines'
import { getApp, setApp, useApp } from './store'

const camera = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  setSource: vi.fn(async () => {}),
  setEnabled: vi.fn(async () => {}),
  subscribe: vi.fn(() => () => {})
}))

vi.mock('../engine/camera/pipeline', () => ({
  CameraPipeline: function CameraPipeline() {
    return camera
  }
}))

const ESP32: CameraSource = { kind: 'mjpeg', url: 'http://192.168.4.1:81/stream' }

describe('engines', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { fastasl: { isDev: false } })
    useApp.setState(useApp.getInitialState(), true)
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.unstubAllGlobals()
  })

  it('starts the camera with the saved settings', () => {
    setApp({ cameraOn: false, cameraSource: ESP32 })
    stop = startEngines()
    expect(camera.setEnabled).toHaveBeenCalledWith(false)
    expect(camera.start).toHaveBeenCalledWith(ESP32)
  })

  it('follows the camera toggle and source changes', () => {
    stop = startEngines()
    setApp({ cameraOn: !getApp().cameraOn })
    expect(camera.setEnabled).toHaveBeenLastCalledWith(false)
    setApp({ cameraSource: ESP32 })
    expect(camera.setSource).toHaveBeenCalledWith(ESP32)
    setApp({ mode: 'spell' })
    expect(camera.setSource).toHaveBeenCalledTimes(1)
    expect(camera.setEnabled).toHaveBeenCalledTimes(2)
  })

  it('stops the camera and ignores the store once stopped', () => {
    startEngines()()
    expect(camera.stop).toHaveBeenCalledTimes(1)
    setApp({ cameraSource: ESP32 })
    expect(camera.setSource).not.toHaveBeenCalled()
  })

  it('fans frames out through the pipeline', () => {
    const fn = vi.fn()
    subscribeFrames(fn)
    expect(camera.subscribe).toHaveBeenCalledWith(fn)
  })
})
