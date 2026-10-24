import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTemplatePack, TEMPLATE_DIMS } from '@shared/templatePack'
import type { SignTemplate } from '@shared/types'
import { BUILTIN_PEACE, DEFAULT_SETTINGS, getGestures, getSettings, getTemplates, importTemplatePack, saveTemplates } from './store'

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

  it('always starts with the built-in peace sign, which the file can override', () => {
    expect(getGestures()).toEqual([BUILTIN_PEACE])
    write({ not: 'a list' })
    expect(getGestures()).toEqual([BUILTIN_PEACE])
    write([{ id: BUILTIN_PEACE.id, task: 'Text me', builtin: false }])
    expect(getGestures()).toEqual([{ ...BUILTIN_PEACE, task: 'Text me', builtin: true }])
  })

  it('drops hand-edited entries that cannot run and fills in the rest', () => {
    write([
      null,
      'g0',
      { id: 'g1', name: 'Gesture 1' },
      { id: 'g2', name: 'Gesture 2', task: 'Open Notes', shape: [[0.1, 0.2], null, 'x'], compiled: 'open_app', createdAt: 5 },
      { id: 'g3', task: 'Open Calculator' }
    ])
    expect(getGestures().slice(1)).toEqual([
      { id: 'g2', name: 'Gesture 2', task: 'Open Notes', shape: [[0.1, 0.2]], createdAt: 5 },
      { id: 'g3', name: 'g3', task: 'Open Calculator', shape: [], createdAt: 0 }
    ])
  })
})
