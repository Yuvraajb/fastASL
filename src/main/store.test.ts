import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTemplatePack, TEMPLATE_DIMS } from '@shared/templatePack'
import type { Settings, SignTemplate } from '@shared/types'
import {
  DEFAULT_SETTINGS,
  getGestures,
  getSettings,
  getTemplates,
  importTemplatePack,
  saveSettings,
  saveTemplates
} from './store'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

describe('getSettings', () => {
  let dir: string
  const write = (value: unknown): void => writeFileSync(join(dir, 'settings.json'), JSON.stringify(value))

  const read = (): Partial<Settings> => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Partial<Settings>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fastasl-settings-'))
    vi.stubEnv('FASTASL_DATA_DIR', dir)
    vi.stubEnv('FASTASL_MJPEG_URL', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the defaults without a settings file', () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the default for a broken mode, sensitivity or camera switch', () => {
    write({ mode: 'shout', sensitivity: 11, cameraEnabled: 'yes', streamUrl: 42 })
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
    write(['not', 'settings'])
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
    write({ mode: 'dictation', sensitivity: 'high', cameraEnabled: false })
    expect(getSettings()).toMatchObject({ mode: 'dictation', sensitivity: 'high', cameraEnabled: false })
  })

  it('uses FASTASL_MJPEG_URL as the stream URL until one is saved, without writing it', () => {
    vi.stubEnv('FASTASL_MJPEG_URL', ' http://192.168.4.1:81/stream ')
    expect(getSettings().streamUrl).toBe('http://192.168.4.1:81/stream')
    saveSettings({ sensitivity: 'low' })
    expect(read().streamUrl).toBe('')
    vi.stubEnv('FASTASL_MJPEG_URL', 'http://192.168.4.2:81/stream')
    expect(getSettings()).toMatchObject({ sensitivity: 'low', streamUrl: 'http://192.168.4.2:81/stream' })
    saveSettings({ streamUrl: 'http://cam.local:81/stream' })
    expect(getSettings().streamUrl).toBe('http://cam.local:81/stream')
  })

  it('a stream picked with the FASTASL_MJPEG_URL follows later .env edits, and later saves never write the URL', () => {
    vi.stubEnv('FASTASL_MJPEG_URL', 'http://192.168.1.50:81/stream')
    saveSettings({ cameraSource: { kind: 'mjpeg', url: getSettings().streamUrl }, cameraEnabled: true })
    saveSettings({ mode: 'dictation' })
    expect(read().streamUrl).toBe('')
    vi.stubEnv('FASTASL_MJPEG_URL', 'http://192.168.1.51:81/stream')
    expect(getSettings()).toMatchObject({
      cameraSource: { kind: 'mjpeg', url: 'http://192.168.1.51:81/stream' },
      streamUrl: 'http://192.168.1.51:81/stream',
      mode: 'dictation'
    })
    // Without the .env line it keeps the stream it had.
    vi.stubEnv('FASTASL_MJPEG_URL', '')
    expect(getSettings()).toMatchObject({ cameraSource: { kind: 'mjpeg', url: 'http://192.168.1.50:81/stream' }, streamUrl: 'http://192.168.1.50:81/stream' })
  })

  it('a typed stream URL wins over FASTASL_MJPEG_URL', () => {
    vi.stubEnv('FASTASL_MJPEG_URL', 'http://192.168.1.50:81/stream')
    saveSettings({ cameraSource: { kind: 'mjpeg', url: 'http://cam.local:81/stream' }, streamUrl: 'http://cam.local:81/stream' })
    expect(getSettings()).toMatchObject({ cameraSource: { kind: 'mjpeg', url: 'http://cam.local:81/stream' }, streamUrl: 'http://cam.local:81/stream' })
  })

  it('keeps the stream URL when the MacBook camera is picked', () => {
    // A file from before streamUrl: the URL lives only in the source.
    write({ cameraSource: { kind: 'mjpeg', url: 'http://192.168.4.1:81/stream' } })
    expect(getSettings().streamUrl).toBe('http://192.168.4.1:81/stream')
    expect(saveSettings({ cameraSource: { kind: 'builtin' } })).toMatchObject({
      cameraSource: { kind: 'builtin' },
      streamUrl: 'http://192.168.4.1:81/stream'
    })
    expect(read().streamUrl).toBe('http://192.168.4.1:81/stream')
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

describe('importTemplatePack', () => {
  let dir: string
  const letter = (id: string): SignTemplate => ({
    id,
    label: 'A',
    kind: 'letter',
    frames: [new Array<number>(TEMPLATE_DIMS.letter).fill(0.5)],
    createdAt: 1
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fastasl-templates-'))
    vi.stubEnv('FASTASL_DATA_DIR', dir)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds the templates whose id is new', () => {
    saveTemplates({ version: 1, templates: [letter('a')] })
    expect(importTemplatePack(createTemplatePack([letter('a'), letter('b')]))).toEqual({ added: 1, skipped: 1 })
    expect(getTemplates().templates.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('rejects an invalid pack and leaves the store alone', () => {
    saveTemplates({ version: 1, templates: [letter('a')] })
    const pack = createTemplatePack([{ ...letter('b'), frames: [[1, 2, 3]] }])
    expect(importTemplatePack(pack)).toEqual(new Error('templates[0]: frames[0] must have 63 numbers'))
    expect(importTemplatePack({ format: 'zip' })).toBeInstanceOf(Error)
    expect(getTemplates().templates.map((t) => t.id)).toEqual(['a'])
  })
})

describe('getGestures', () => {
  let dir: string
  const write = (value: unknown): void => writeFileSync(join(dir, 'gestures.json'), JSON.stringify(value))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fastasl-gestures-'))
    vi.stubEnv('FASTASL_DATA_DIR', dir)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('has no gestures until some are saved, and ignores a saved built-in peace sign', () => {
    expect(getGestures()).toEqual([])
    write({ not: 'a list' })
    expect(getGestures()).toEqual([])
    write([{ id: 'builtin-peace', task: 'Take a screenshot', builtin: true }])
    expect(getGestures()).toEqual([])
  })

  it('drops hand-edited entries that cannot run and fills in the rest', () => {
    write([
      null,
      'g0',
      { id: 'g1', name: 'Gesture 1' },
      { id: 'g2', name: 'Gesture 2', task: 'Open Notes', shape: [[0.1, 0.2], null, 'x'], compiled: 'open_app', createdAt: 5 },
      { id: 'g3', task: 'Open Calculator' }
    ])
    expect(getGestures()).toEqual([
      { id: 'g2', name: 'Gesture 2', task: 'Open Notes', shape: [[0.1, 0.2]], createdAt: 5 },
      { id: 'g3', name: 'g3', task: 'Open Calculator', shape: [], createdAt: 0 }
    ])
  })
})
