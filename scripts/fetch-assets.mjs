#!/usr/bin/env node
// Puts the MediaPipe and onnxruntime runtimes next to the renderer so they work offline in dev
// (http) and prod (file://). All of it is gitignored:
//   src/renderer/public/mediapipe/wasm/vision_wasm_internal.{js,wasm}   copied from @mediapipe/tasks-vision
//   src/renderer/public/mediapipe/hand_landmarker.task                  downloaded once (~7.8 MB)
//   src/renderer/public/mediapipe/face_landmarker.task                  downloaded once (~3.8 MB, the sign model's face)
//   src/renderer/public/mediapipe/pose_landmarker_lite.task             downloaded once (~5.8 MB, ASL Citizen's body pose)
//   src/renderer/public/ort/ort-wasm-simd-threaded.{wasm,mjs}           copied from onnxruntime-web (the sign model's runtime)
// The Kaggle sign model itself (public/models/islr1st.onnx) is committed; ASL Citizen's is
// installed separately by `npm run setup:citizen`.
// Idempotent: unchanged files are skipped. Exits non-zero on any failure.

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/renderer/public/mediapipe')
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']
const MODELS = [
  ['https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', 'hand_landmarker.task'],
  ['https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', 'face_landmarker.task'],
  ['https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', 'pose_landmarker_lite.task']
].map(([url, name]) => ({ url, path: join(OUT, name) }))
const ORT_OUT = join(ROOT, 'src/renderer/public/ort')
const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']
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

/** onnxruntime-web's wasm build, from its dist folder (the wasm files aren't in its export map). */
async function copyOrt() {
  await mkdir(ORT_OUT, { recursive: true })
  const dist = dirname(require.resolve('onnxruntime-web'))
  for (const name of ORT_FILES) {
    const src = join(dist, name)
    const target = join(ORT_OUT, name)
    if (await sameContent(src, target)) {
      log(`up to date  ${rel(target)}`)
      continue
    }
    await copyFile(src, target)
    log(`copied      ${rel(target)}`)
  }
}

async function downloadModel({ url, path }) {
  if ((await sizeOf(path)) > 0) {
    log(`present     ${rel(path)}`)
    return
  }
  log(`downloading ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
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
  const part = `${path}.part`
  await writeFile(part, bytes)
  await rename(part, path)
  log(`saved       ${rel(path)} (${(bytes.length / 1e6).toFixed(1)} MB)`)
}

try {
  await mkdir(OUT, { recursive: true })
  await copyWasm()
  await copyOrt()
  for (const model of MODELS) await downloadModel(model)
  log('MediaPipe and sign model assets ready')
} catch (err) {
  for (const { path } of MODELS) await rm(`${path}.part`, { force: true })
  console.error(`[fetch-assets] FAILED: ${err instanceof Error ? err.message : err}`)
  console.error('[fetch-assets] Hand tracking and the sign model need these files. Check your network and run `npm run setup` again.')
  process.exit(1)
}
