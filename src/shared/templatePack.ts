import type { SignTemplate, TemplatePack } from './types'

// Shared so the main process (tray import, IPC) validates packs exactly like the renderer.
// scripts/templates.mjs repeats these rules for the command line; keep the two in step
// (engine/recognition/pack.test.ts checks that both reject the same packs).

export const PACK_FORMAT = 'fastasl-template-pack'
/**
 * Vector sizes of stored frames: FRAME_FEATURE_DIM (word) and STATIC_FEATURE_DIM (letter) in
 * renderer/src/engine/recognition/features.ts, repeated here because main can't import renderer
 * code (pack.test.ts checks they agree).
 */
export const TEMPLATE_DIMS = { word: 134, letter: 63 } as const
const MAX_FRAMES = 512
const MAX_LABEL = 64
const MAX_ID = 200

export function createTemplatePack(templates: readonly SignTemplate[], now = new Date()): TemplatePack {
  return { format: PACK_FORMAT, version: 1, exportedAt: now.toISOString(), templates: [...templates] }
}

/** Strictly validate an imported pack. Returns a clean copy, or an Error saying what is wrong. */
export function validateTemplatePack(json: unknown): TemplatePack | Error {
  if (!isRecord(json)) return new Error('Not a template pack: expected a JSON object')
  if (json.format !== PACK_FORMAT) return new Error(`Unknown format ${JSON.stringify(json.format)}, expected "${PACK_FORMAT}"`)
  if (json.version !== 1) return new Error(`Unsupported pack version ${JSON.stringify(json.version)}`)
  if (typeof json.exportedAt !== 'string' || Number.isNaN(Date.parse(json.exportedAt))) {
    return new Error('exportedAt must be an ISO date string')
  }
  if (!Array.isArray(json.templates)) return new Error('templates must be an array')

  const templates: SignTemplate[] = []
  const ids = new Set<string>()
  for (const [i, raw] of json.templates.entries()) {
    const t = validateTemplate(raw)
    if (typeof t === 'string') return new Error(`templates[${i}]: ${t}`)
    if (ids.has(t.id)) return new Error(`templates[${i}]: duplicate id "${t.id}"`)
    ids.add(t.id)
    templates.push(t)
  }
  return { format: PACK_FORMAT, version: 1, exportedAt: json.exportedAt, templates }
}

function validateTemplate(raw: unknown): SignTemplate | string {
  if (!isRecord(raw)) return 'expected an object'
  const { id, label, kind, frames, createdAt } = raw
  if (typeof id !== 'string' || !id || id.length > MAX_ID) return 'id must be a non-empty string'
  if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL) {
    return `label must be 1-${MAX_LABEL} characters`
  }
  if (kind !== 'word' && kind !== 'letter') return 'kind must be "word" or "letter"'
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    return 'createdAt must be a timestamp'
  }
  const dim = TEMPLATE_DIMS[kind]
  const minFrames = kind === 'word' ? 2 : 1
  if (!Array.isArray(frames) || frames.length < minFrames || frames.length > MAX_FRAMES) {
    return `a ${kind} needs ${minFrames}-${MAX_FRAMES} frames`
  }
  for (const [j, frame] of frames.entries()) {
    if (!Array.isArray(frame) || frame.length !== dim) return `frames[${j}] must have ${dim} numbers`
    if (!frame.every((v) => typeof v === 'number' && Number.isFinite(v))) return `frames[${j}] has a non-numeric value`
  }
  return { id, label, kind, frames: frames.map((f: number[]) => [...f]), createdAt }
}

/** Existing templates first, then incoming ones whose id is new (duplicates dropped). */
export function mergeTemplates(existing: readonly SignTemplate[], incoming: readonly SignTemplate[]): SignTemplate[] {
  const ids = new Set(existing.map((t) => t.id))
  const merged = [...existing]
  for (const t of incoming) {
    if (ids.has(t.id)) continue
    ids.add(t.id)
    merged.push(t)
  }
  return merged
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
