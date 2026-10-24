import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CompletedTask, CustomGesture, Settings, TemplateStore } from '@shared/types'

/** ~/Library/Application Support/fastASL */
export function dataDir(): string {
  const dir = join(app.getPath('appData'), 'fastASL')
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

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>('settings.json', {}) }
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

export function getGestures(): CustomGesture[] {
  const saved = readJson<CustomGesture[]>('gestures.json', [])
  const list = Array.isArray(saved) ? saved.filter((g) => g.id !== BUILTIN_PEACE.id) : []
  const builtin = saved.find?.((g) => g.id === BUILTIN_PEACE.id)
  return [{ ...BUILTIN_PEACE, ...(builtin ?? {}), builtin: true }, ...list]
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
