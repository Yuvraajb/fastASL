#!/usr/bin/env node
// Sign template packs, outside the app.
//   node scripts/templates.mjs export <out.json>   write every recorded sign to a pack
//   node scripts/templates.mjs import <pack.json>  validate a pack and merge it in (by id)
//   node scripts/templates.mjs stats               what is recorded, per label
// Reads/writes ~/Library/Application Support/fastASL/signs.json, or $FASTASL_DATA_DIR/signs.json
// like the app (try FASTASL_DATA_DIR=$(mktemp -d) first).
// Validation mirrors src/shared/templatePack.ts; keep the two in step.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const FORMAT = 'fastasl-template-pack'
const DIMS = { word: 134, letter: 63 } // FRAME_FEATURE_DIM, STATIC_FEATURE_DIM
const MIN_FRAMES = { word: 2, letter: 1 }
const MAX_FRAMES = 512
const MAX_LABEL = 64
const MAX_ID = 200

const dataDir = process.env.FASTASL_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'fastASL')
const storePath = join(dataDir, 'signs.json')

function fail(message) {
  console.error(`templates: ${message}`)
  process.exit(1)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    fail(`cannot read ${path}: ${err.message}`)
  }
}

/** tmp + rename, so a crash never leaves a half-written file. */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

function readStore() {
  const store = readJson(storePath)
  if (store === undefined) return { version: 1, templates: [] }
  if (!store || !Array.isArray(store.templates)) fail(`${storePath} is not a template store`)
  return store
}

function templateError(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'expected an object'
  if (typeof t.id !== 'string' || !t.id || t.id.length > MAX_ID) return 'id must be a non-empty string'
  if (typeof t.label !== 'string' || !t.label.trim() || t.label.length > MAX_LABEL) {
    return `label must be 1-${MAX_LABEL} characters`
  }
  if (t.kind !== 'word' && t.kind !== 'letter') return 'kind must be "word" or "letter"'
  if (typeof t.createdAt !== 'number' || !Number.isFinite(t.createdAt) || t.createdAt < 0) {
    return 'createdAt must be a timestamp'
  }
  const frames = t.frames
  if (!Array.isArray(frames) || frames.length < MIN_FRAMES[t.kind] || frames.length > MAX_FRAMES) {
    return `a ${t.kind} needs ${MIN_FRAMES[t.kind]}-${MAX_FRAMES} frames`
  }
  for (const [j, f] of frames.entries()) {
    if (!Array.isArray(f) || f.length !== DIMS[t.kind]) return `frames[${j}] must have ${DIMS[t.kind]} numbers`
    if (!f.every((v) => typeof v === 'number' && Number.isFinite(v))) return `frames[${j}] has a non-numeric value`
  }
  return null
}

function packError(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return 'not a template pack: expected a JSON object'
  if (pack.format !== FORMAT) return `unknown format ${JSON.stringify(pack.format)}, expected "${FORMAT}"`
  if (pack.version !== 1) return `unsupported pack version ${JSON.stringify(pack.version)}`
  if (typeof pack.exportedAt !== 'string' || Number.isNaN(Date.parse(pack.exportedAt))) {
    return 'exportedAt must be an ISO date string'
  }
  if (!Array.isArray(pack.templates)) return 'templates must be an array'
  const ids = new Set()
  for (const [i, t] of pack.templates.entries()) {
    const error = templateError(t)
    if (error) return `templates[${i}]: ${error}`
    if (ids.has(t.id)) return `templates[${i}]: duplicate id "${t.id}"`
    ids.add(t.id)
  }
  return null
}

function exportPack(out) {
  if (!out) fail('usage: templates.mjs export <out.json>')
  const { templates } = readStore()
  writeJsonAtomic(resolve(out), { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), templates })
  console.log(`Exported ${templates.length} template(s) to ${resolve(out)}`)
}

function importPack(file) {
  if (!file) fail('usage: templates.mjs import <pack.json>')
  const pack = readJson(resolve(file))
  if (pack === undefined) fail(`${file} not found`)
  const error = packError(pack)
  if (error) fail(`invalid pack: ${error}`)
  const store = readStore()
  const ids = new Set(store.templates.map((t) => t.id))
  const fresh = pack.templates
    .filter((t) => !ids.has(t.id))
    .map(({ id, label, kind, frames, createdAt }) => ({ id, label, kind, frames, createdAt }))
  writeJsonAtomic(storePath, { version: 1, templates: [...store.templates, ...fresh] })
  console.log(`Imported ${fresh.length} new template(s), skipped ${pack.templates.length - fresh.length} already present`)
}

function stats() {
  const { templates } = readStore()
  console.log(storePath)
  const byLabel = new Map()
  for (const t of templates) {
    const key = `${String(t.kind).padEnd(6)} ${t.label}`
    const entry = byLabel.get(key) ?? { reps: 0, frames: 0, bad: 0 }
    entry.reps++
    entry.frames += Array.isArray(t.frames) ? t.frames.length : 0
    if (templateError(t)) entry.bad++
    byLabel.set(key, entry)
  }
  const words = templates.filter((t) => t.kind === 'word').length
  console.log(`${templates.length} template(s): ${words} word, ${templates.length - words} letter, ${byLabel.size} label(s)`)
  for (const [key, e] of [...byLabel].sort(([a], [b]) => a.localeCompare(b))) {
    const bad = e.bad ? `  (${e.bad} invalid)` : ''
    console.log(`  ${key.padEnd(24)} ${String(e.reps).padStart(3)} rep(s), ${Math.round(e.frames / e.reps)} frame(s) each${bad}`)
  }
}

const [command, arg] = process.argv.slice(2)
if (command === 'export') exportPack(arg)
else if (command === 'import') importPack(arg)
else if (command === 'stats') stats()
else fail('usage: templates.mjs export <out.json> | import <pack.json> | stats')
