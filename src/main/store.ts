import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { mergeTemplates, validateTemplatePack } from '@shared/templatePack'
import type { CameraSource, CompletedTask, CustomGesture, Settings, TemplateStore } from '@shared/types'

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
  mode: 'command'
}

function isCameraSource(value: unknown): value is CameraSource {
  const v = value as { kind?: unknown; deviceId?: unknown; url?: unknown } | null
  if (typeof v !== 'object' || v === null) return false
  if (v.kind === 'builtin') return v.deviceId === undefined || typeof v.deviceId === 'string'
  return v.kind === 'mjpeg' && typeof v.url === 'string'
}

/** Main and renderer both read settings here, so a hand-edited or broken camera source can't crash boot. */
export function getSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>('settings.json', {}) }
  if (!isCameraSource(settings.cameraSource)) settings.cameraSource = DEFAULT_SETTINGS.cameraSource
  return settings
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  writeJson('settings.json', next)
  return next
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

/** The built-in peace-sign screenshot shortcut is always present. */
export const BUILTIN_PEACE: CustomGesture = {
  id: 'builtin-peace',
  name: 'Peace sign',
  task: 'Take a screenshot',
  shape: [],
  compiled: [{ tool: 'take_screenshot', args: {}, ok: true }],
  builtin: true,
  createdAt: 0
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
  const builtin = entries.find((g) => g.id === BUILTIN_PEACE.id)
  const peace = toGesture({ ...BUILTIN_PEACE, ...builtin })[0] ?? BUILTIN_PEACE
  const custom = entries.filter((g) => g.id !== BUILTIN_PEACE.id).flatMap(toGesture)
  return [{ ...peace, builtin: true }, ...custom]
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
