#!/usr/bin/env node
// Puts the MediaPipe runtime next to the renderer so it works offline in dev (http) and prod (file://):
//   src/renderer/public/mediapipe/wasm/vision_wasm_internal.{js,wasm}   copied from @mediapipe/tasks-vision
//   src/renderer/public/mediapipe/hand_landmarker.task                  downloaded once (~7.8 MB)
// Idempotent: unchanged files are skipped. Exits non-zero on any failure.

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/renderer/public/mediapipe')
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']
const HAND_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const HAND_PATH = join(OUT, 'hand_landmarker.task')
// Face box for face-relative sign locations (forehead, chin). Optional: signs fall back to frame regions without it.
const FACE_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const FACE_PATH = join(OUT, 'face_detector.tflite')
const DOWNLOAD_TIMEOUT_MS = 120_000

const require = createRequire(import.meta.url)
const rel = (path) => relative(ROOT, path)
const log = (msg) => console.log(`[fetch-assets] ${msg}`)

async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

async function sameContent(a, b) {
  if ((await sizeOf(a)) !== (await sizeOf(b))) return false
  const hash = async (path) => createHash('sha1').update(await readFile(path)).digest('hex')
  return (await hash(a)) === (await hash(b))
}

async function copyWasm() {
  const dest = join(OUT, 'wasm')
  await mkdir(dest, { recursive: true })
  for (const name of WASM_FILES) {
    // Resolve through the package's export map so hoisted / nested installs both work.
    const src = require.resolve(`@mediapipe/tasks-vision/${name}`)
    const target = join(dest, name)
    if (await sameContent(src, target)) {
      log(`up to date  ${rel(target)}`)
      continue
    }
    await copyFile(src, target)
    log(`copied      ${rel(target)}`)
  }
}

async function downloadModel(MODEL_URL = HAND_URL, MODEL_PATH = HAND_PATH) {
  if ((await sizeOf(MODEL_PATH)) > 0) {
    log(`present     ${rel(MODEL_PATH)}`)
    return
  }
  log(`downloading ${MODEL_URL}`)
  const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status} ${res.statusText}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const expected = Number(res.headers.get('content-length'))
  if (expected && bytes.length !== expected) {
    throw new Error(`model download truncated: got ${bytes.length} of ${expected} bytes`)
  }
  // Google Cloud Storage publishes the object's MD5; verify it when present.
  const md5 = /md5=([A-Za-z0-9+/=]+)/.exec(res.headers.get('x-goog-hash') ?? '')?.[1]
  if (md5 && createHash('md5').update(bytes).digest('base64') !== md5) {
    throw new Error('model download is corrupted (MD5 mismatch)')
  }
  // Write then rename so an interrupted run never leaves a half-written model behind.
  const part = `${MODEL_PATH}.part`
  await writeFile(part, bytes)
  await rename(part, MODEL_PATH)
  log(`saved       ${rel(MODEL_PATH)} (${(bytes.length / 1e6).toFixed(1)} MB)`)
}

try {
  await mkdir(OUT, { recursive: true })
  await copyWasm()
  await downloadModel(HAND_URL, HAND_PATH)
  await downloadModel(FACE_URL, FACE_PATH)
  log('MediaPipe assets ready')
} catch (err) {
  await rm(`${HAND_PATH}.part`, { force: true })
  await rm(`${FACE_PATH}.part`, { force: true })
  console.error(`[fetch-assets] FAILED: ${err instanceof Error ? err.message : err}`)
  console.error('[fetch-assets] Hand tracking needs these files. Check your network and run `npm run setup` again.')
  process.exit(1)
}
