import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { mergeTemplates, validateTemplatePack } from '@shared/templatePack'
import type { CameraSource, CompletedTask, CustomGesture, Mode, Sensitivity, Settings, TemplateStore } from '@shared/types'

/** ~/Library/Application Support/fastASL, or FASTASL_DATA_DIR (dev / smoke tests). */
export function dataDir(): string {
  const dir = process.env.FASTASL_DATA_DIR || join(app.getPath('appData'), 'fastASL')
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dataDir(), file), 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Atomic write (tmp + rename) so a crash never leaves a half-written file. */
function writeJson(file: string, value: unknown): void {
  const path = join(dataDir(), file)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

export const DEFAULT_SETTINGS: Settings = {
  cameraSource: { kind: 'builtin' },
  cameraEnabled: true,
  sensitivity: 'medium',
  mode: 'command',
  streamUrl: ''
}

const SENSITIVITIES: readonly unknown[] = ['low', 'medium', 'high'] satisfies Sensitivity[]
const MODES: readonly unknown[] = ['command', 'dictation', 'spell'] satisfies Mode[]

function isCameraSource(value: unknown): value is CameraSource {
  const v = value as { kind?: unknown; deviceId?: unknown; url?: unknown } | null
  if (typeof v !== 'object' || v === null) return false
  if (v.kind === 'builtin') return v.deviceId === undefined || typeof v.deviceId === 'string'
  return v.kind === 'mjpeg' && typeof v.url === 'string'
}

/** settings.json over the defaults. A hand-edited or broken value falls back to its default, so it can't crash boot. */
function savedSettings(): Settings {
  const saved = readJson<unknown>('settings.json', {})
  const file = typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved : {}
  const s = { ...DEFAULT_SETTINGS, ...file } as Settings
  if (!isCameraSource(s.cameraSource)) s.cameraSource = DEFAULT_SETTINGS.cameraSource
  if (typeof s.cameraEnabled !== 'boolean') s.cameraEnabled = DEFAULT_SETTINGS.cameraEnabled
  if (!SENSITIVITIES.includes(s.sensitivity)) s.sensitivity = DEFAULT_SETTINGS.sensitivity
  if (!MODES.includes(s.mode)) s.mode = DEFAULT_SETTINGS.mode
  if (typeof s.streamUrl !== 'string') s.streamUrl = DEFAULT_SETTINGS.streamUrl
  // A file from before streamUrl kept the typed URL only in its source.
  if (!('streamUrl' in file) && s.cameraSource.kind === 'mjpeg') s.streamUrl = s.cameraSource.url
  return s
}

/**
 * Main and renderer both read settings here. Until a stream URL is typed (the file's
 * streamUrl is ''), FASTASL_MJPEG_URL (.env) stands in for it, and a stream picked with it
 * follows a later .env edit. It is never written to the file.
 */
export function getSettings(): Settings {
  const settings = savedSettings()
  if (settings.streamUrl) return settings
  const envUrl = process.env.FASTASL_MJPEG_URL?.trim() ?? ''
  if (settings.cameraSource.kind === 'mjpeg' && envUrl) settings.cameraSource = { kind: 'mjpeg', url: envUrl }
  settings.streamUrl = settings.cameraSource.kind === 'mjpeg' ? settings.cameraSource.url : envUrl
  return settings
}

export function saveSettings(patch: Partial<Settings>): Settings {
  writeJson('settings.json', { ...savedSettings(), ...patch })
  return getSettings()
}

export function getTemplates(): TemplateStore {
  const store = readJson<TemplateStore>('signs.json', { version: 1, templates: [] })
  return Array.isArray(store.templates) ? store : { version: 1, templates: [] }
}

export function saveTemplates(store: TemplateStore): void {
  writeJson('signs.json', store)
}

/** Validates a template pack and adds its templates whose id is new. */
export function importTemplatePack(json: unknown): { added: number; skipped: number } | Error {
  const pack = validateTemplatePack(json)
  if (pack instanceof Error) return pack
  const current = getTemplates().templates
  const templates = mergeTemplates(current, pack.templates)
  saveTemplates({ version: 1, templates })
  const added = templates.length - current.length
  return { added, skipped: pack.templates.length - added }
}

const isNumberList = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number')

/**
 * A hand-edited entry may hold anything. One without a string id and task can't run and is
 * dropped; the rest get a name, a list of number vectors as shape, and a list of compiled steps or none.
 */
function toGesture(g: Partial<CustomGesture>): CustomGesture[] {
  if (typeof g.id !== 'string' || typeof g.task !== 'string') return []
  return [
    {
      ...g,
      id: g.id,
      task: g.task,
      name: typeof g.name === 'string' ? g.name : g.id,
      shape: Array.isArray(g.shape) ? g.shape.filter(isNumberList) : [],
      compiled: Array.isArray(g.compiled) ? g.compiled : undefined,
      createdAt: typeof g.createdAt === 'number' ? g.createdAt : 0
    }
  ]
}

export function getGestures(): CustomGesture[] {
  const saved = readJson<unknown>('gestures.json', [])
  const entries = (Array.isArray(saved) ? saved : []).filter(
    (g): g is Partial<CustomGesture> => typeof g === 'object' && g !== null
  )
  // The built-in peace-sign shortcut is gone: a saved entry for it is ignored.
  return entries.filter((g) => g.id !== 'builtin-peace').flatMap(toGesture)
}

export function saveGestures(gestures: CustomGesture[]): void {
  writeJson('gestures.json', gestures)
}

export function getRecentTasks(): CompletedTask[] {
  const tasks = readJson<CompletedTask[]>('tasks.json', [])
  return Array.isArray(tasks) ? tasks : []
}

export function addRecentTask(task: CompletedTask): void {
  const tasks = [task, ...getRecentTasks().filter((t) => t.intent !== task.intent)].slice(0, 10)
  writeJson('tasks.json', tasks)
}
