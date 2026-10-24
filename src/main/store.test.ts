import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, getSettings } from './store'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

describe('getSettings', () => {
  let dir: string
  const write = (value: unknown): void => writeFileSync(join(dir, 'settings.json'), JSON.stringify(value))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fastasl-settings-'))
    vi.stubEnv('FASTASL_DATA_DIR', dir)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the defaults without a settings file', () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid camera sources', () => {
    write({ cameraSource: { kind: 'mjpeg', url: 'http://192.168.4.1:81/stream' }, cameraEnabled: false })
    expect(getSettings()).toMatchObject({ cameraSource: { kind: 'mjpeg', url: 'http://192.168.4.1:81/stream' }, cameraEnabled: false })
    write({ cameraSource: { kind: 'builtin', deviceId: 'abc' } })
    expect(getSettings().cameraSource).toEqual({ kind: 'builtin', deviceId: 'abc' })
  })

  it.each([null, 'builtin', { kind: 'mjpeg' }, { kind: 'mjpeg', url: 42 }, { kind: 'usb' }, { kind: 'builtin', deviceId: 1 }])(
    'falls back to the built-in camera for a broken camera source (%j)',
    (cameraSource) => {
      write({ cameraSource, mode: 'spell' })
      expect(getSettings()).toMatchObject({ cameraSource: { kind: 'builtin' }, mode: 'spell' })
    }
  )
})
