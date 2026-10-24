#!/usr/bin/env node
// Builds the optional ASL Citizen sign recognizer (2731 isolated ASL signs) for the renderer, in Node only:
//   src/renderer/public/models/asl-citizen/aslcitizen_stgcn.onnx   ST-GCN converted from Microsoft's PyTorch checkpoint
//   src/renderer/public/models/asl-citizen/labels.json             class index -> gloss (sorted unique train-split glosses)
//   src/renderer/public/models/asl-citizen/README.txt              provenance + licence
//
// LICENCE: the ASL Citizen weights and dataset are under a Microsoft Research licence (non-commercial research use
// only, no redistribution). Everything in that folder is derived from them: it is gitignored, never commit or ship it.
//
// Downloads ~29.8 MB: the weights release zip (~28.9 MB) plus, from the 45.9 GB dataset zip, only its end records,
// the start of its central directory and the compressed splits/train.csv (~0.8 MB) via HTTP Range requests.
//
// usage: node scripts/setup-asl-citizen.mjs [--weights <ASL_citizen_stgcn_weights.zip or .pt>] [--labels <train.csv>] [--force]

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { buildStgcnOnnx } from './asl-citizen/stgcn.mjs'
import { loadStateDict } from './asl-citizen/torchPickle.mjs'
import { bufferSource, findEntry, httpSource, openZip, readEntry } from './asl-citizen/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/renderer/public/models/asl-citizen')
const MODEL_PATH = join(OUT, 'aslcitizen_stgcn.onnx')
const LABELS_PATH = join(OUT, 'labels.json')
const README_PATH = join(OUT, 'README.txt')

const PROJECT_URL = 'https://www.microsoft.com/en-us/research/project/asl-citizen/'
const WEIGHTS_URL = 'https://github.com/microsoft/ASL-citizen-code/releases/download/checkpoints_v1/ASL_citizen_stgcn_weights.zip'
const DATASET_URL = 'https://download.microsoft.com/download/b/8/8/b88c0bae-e6c1-43e1-8726-98cf5af36ca4/ASL_Citizen.zip'
const TRAIN_CSV = 'ASL_Citizen/splits/train.csv'
// SHA-256 of the checkpoints_v1 release zip and of the checkpoint inside it (what the converter was verified against).
const WEIGHTS_ZIP_SHA256 = '4b52578ed24ed975756c6447c56ba9bb90576eb302518c9b3aef955bfb20eb01'
const CHECKPOINT_SHA256 = 'b08d84afb5a0fdf4c723fd7be2db897b2490a921ccf538cff1b345f905934d68'
const ESTIMATE = { weights: 28_885_375, datasetIndex: 66_560, trainCsv: 801_906 }

const HEAD_TIMEOUT_MS = 30_000
const RANGE_TIMEOUT_MS = 120_000
const WEIGHTS_TIMEOUT_MS = 600_000
const DATASET_BYTE_CAP = 24 * 1024 * 1024 // hard cap on bytes taken from the 45.9 GB dataset zip

const rel = (path) => relative(ROOT, path)
const log = (msg) => console.log(`[setup-asl-citizen] ${msg}`)
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`
const bytes = (n) => `${n.toLocaleString('en-US')} bytes`
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const USAGE = `usage: node scripts/setup-asl-citizen.mjs [options]
  --weights <path>  use a local ASL_citizen_stgcn_weights.zip (or the .pt inside it) instead of downloading it
  --labels <path>   use a local ASL Citizen splits/train.csv instead of range-reading it from the dataset zip
  --force           rebuild even if the outputs already exist
  -h, --help        show this help`

async function exists(path) {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- labels

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF/LF, optional BOM) -> array of rows. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch !== '"') field += ch
      else if (text[i + 1] === '"') (field += '"'), i++
      else quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === ',') row.push(field), (field = '')
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (quoted) throw new Error('train.csv: unterminated quoted field')
  if (field !== '' || row.length) row.push(field), rows.push(row)
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** Class order = sorted unique Gloss values (default sort = UTF-16 code-unit order, same as Python's sorted() here). */
function glossesFromCsv(text) {
  const [header, ...rows] = parseCsv(text)
  const col = header?.indexOf('Gloss') ?? -1
  if (col < 0) throw new Error(`train.csv: no "Gloss" column (header: ${JSON.stringify(header)})`)
  const glosses = new Set()
  rows.forEach((r, i) => {
    if (r.length !== header.length) throw new Error(`train.csv: row ${i + 2} has ${r.length} fields, expected ${header.length}`)
    glosses.add(r[col])
  })
  if (glosses.has('')) throw new Error('train.csv: empty gloss')
  return { glosses: [...glosses].sort(), rows: rows.length }
}

// ---------------------------------------------------------------- downloads

async function headSize(url) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HEAD ${url} failed: HTTP ${res.status} ${res.statusText}`)
  const size = Number(res.headers.get('content-length'))
  return Number.isSafeInteger(size) && size > 0 ? size : 0
}

async function download(url, expected) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(WEIGHTS_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText} (${url})`)
  const total = Number(res.headers.get('content-length')) || expected
  const chunks = []
  let got = 0
  let next = 0.25
  for await (const chunk of res.body) {
    chunks.push(chunk)
    got += chunk.length
    if (total && got / total >= next && got < total) {
      log(`  ${Math.floor((got / total) * 100)}% (${mb(got)} of ${mb(total)})`)
      next += 0.25
    }
  }
  const buf = Buffer.concat(chunks)
  if (total && buf.length !== total) throw new Error(`download truncated: got ${buf.length} of ${total} bytes`)
  return buf
}

// ---------------------------------------------------------------- main

async function main() {
  let opts
  try {
    ;({ values: opts } = parseArgs({
      options: {
        weights: { type: 'string' },
        labels: { type: 'string' },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }))
  } catch (err) {
    console.error(`[setup-asl-citizen] ${err.message}\n${USAGE}`)
    process.exit(2)
  }
  if (opts.help) {
    console.log(USAGE)
    return
  }

  if (!opts.force && (await exists(MODEL_PATH)) && (await exists(LABELS_PATH))) {
    log(`present     ${rel(MODEL_PATH)} + ${rel(LABELS_PATH)} (use --force to rebuild)`)
    return
  }

  log('ASL Citizen ST-GCN sign recognizer (2731 signs), converted to ONNX locally.')
  log('LICENCE: ASL Citizen weights and data are under a Microsoft Research licence: non-commercial research use')
  log(`only, NO redistribution. Only continue if you have accepted it at ${PROJECT_URL}`)
  log(`The files written to ${rel(OUT)}/ are derived from them: never commit, publish or ship them.`)
  const plan = {
    weights: opts.weights ? 0 : ESTIMATE.weights,
    datasetIndex: opts.labels ? 0 : ESTIMATE.datasetIndex,
    trainCsv: opts.labels ? 0 : ESTIMATE.trainCsv,
  }
  const planTotal = () => plan.weights + plan.datasetIndex + plan.trainCsv
  if (planTotal() === 0) log('Expected download: nothing (local --weights and --labels).')
  else {
    log(`Expected download: ~${mb(planTotal())} = weights ~${mb(plan.weights)} + dataset zip index ~${mb(plan.datasetIndex)}` +
      ` + train.csv ~${mb(plan.trainCsv)} (never any video data from the 45.9 GB dataset zip)`)
  }
  const got = { weights: 0, datasetIndex: 0, trainCsv: 0 }

  // 1) Sizes first, so the exact total is printed before the big download.
  if (!opts.weights) {
    plan.weights = await headSize(WEIGHTS_URL)
    log(`weights     ${WEIGHTS_URL.split('/').pop()}: ${bytes(plan.weights)} (HEAD)`)
  }
  let datasetZip
  let csvEntry
  if (!opts.labels) {
    let what = 'index'
    const source = await httpSource(DATASET_URL, {
      timeoutMs: RANGE_TIMEOUT_MS,
      maxBytes: DATASET_BYTE_CAP,
      onBytes: (n) => (what === 'index' ? (got.datasetIndex += n) : (got.trainCsv += n)),
      label: 'ASL_Citizen.zip',
    })
    const found = await findEntry(source, (e) => e.name === TRAIN_CSV, {
      onEnd: (end) =>
        log(`dataset zip ASL_Citizen.zip: ${(source.size / 1e9).toFixed(1)} GB, ${end.count.toLocaleString('en-US')} entries,` +
          ` central directory ${bytes(end.cdSize)} (read only until ${TRAIN_CSV} is found)`),
    })
    if (!found.entry) throw new Error(`${TRAIN_CSV} is not in the dataset zip`)
    datasetZip = found.zip
    csvEntry = found.entry
    what = 'csv'
    plan.datasetIndex = got.datasetIndex
    plan.trainCsv = 30 + csvEntry.compressedSize // fixed-size local header + compressed data
    log(`train.csv   ${bytes(csvEntry.compressedSize)} compressed (${bytes(csvEntry.size)} unpacked)`)
  }
  if (planTotal()) {
    log(`Exact download: ${bytes(planTotal())} = weights ${bytes(plan.weights)} + dataset zip index ${bytes(plan.datasetIndex)}` +
      ` (already read) + train.csv ${bytes(plan.trainCsv)}`)
  }

  // 2) Labels.
  let csvText
  if (opts.labels) {
    csvText = await readFile(opts.labels, 'utf8')
    log(`labels      ${opts.labels} (local)`)
  } else {
    csvText = (await readEntry(datasetZip, csvEntry)).toString('utf8')
    log(`labels      ${TRAIN_CSV} fetched (${bytes(got.trainCsv)} incl. local header)`)
  }
  const { glosses, rows } = glossesFromCsv(csvText)
  log(`            ${rows.toLocaleString('en-US')} training rows -> ${glosses.length} unique glosses`)

  // 3) Weights.
  let weightsBuf
  if (opts.weights) {
    weightsBuf = await readFile(opts.weights)
    log(`weights     ${opts.weights} (local)`)
  } else {
    log(`downloading ${WEIGHTS_URL}`)
    weightsBuf = await download(WEIGHTS_URL, plan.weights)
    got.weights = weightsBuf.length
  }
  const outer = await openZip(bufferSource(weightsBuf, 'weights zip'))
  let checkpoint
  if ([...outer.entries.keys()].some((n) => n === 'data.pkl' || n.endsWith('/data.pkl'))) {
    checkpoint = weightsBuf // the .pt itself was given
  } else {
    if (sha256(weightsBuf) !== WEIGHTS_ZIP_SHA256) {
      throw new Error('weights zip SHA-256 mismatch: corrupt download or a different release than checkpoints_v1')
    }
    const pt = [...outer.entries.values()].find((e) => e.name.endsWith('.pt'))
    if (!pt) throw new Error('weights zip contains no .pt checkpoint')
    checkpoint = await readEntry(outer, pt)
  }
  if (sha256(checkpoint) !== CHECKPOINT_SHA256) {
    throw new Error('checkpoint SHA-256 mismatch: not the ASL Citizen checkpoints_v1 ST-GCN weights')
  }

  // 4) Convert.
  const t0 = performance.now()
  const sd = await loadStateDict(checkpoint)
  const { bytes: onnx, numClasses } = buildStgcnOnnx(sd, {
    docString: `ASL Citizen ST-GCN (Microsoft, checkpoints_v1), converted by fastASL scripts/setup-asl-citizen.mjs. ` +
      `Microsoft Research licence: non-commercial research use only, no redistribution. ${PROJECT_URL}`,
  })
  const convertMs = performance.now() - t0
  log(`converted   ${sd.size} tensors -> ONNX (${mb(onnx.length)}, ${numClasses} classes) in ${convertMs.toFixed(0)} ms`)
  if (numClasses !== glosses.length) {
    throw new Error(`label count ${glosses.length} does not match the classifier's ${numClasses} outputs`)
  }

  // 5) Write (temp file + rename, so an interrupted run never leaves a half-written file).
  await mkdir(OUT, { recursive: true })
  const readme = [
    'ASL Citizen ST-GCN sign recognizer (generated by scripts/setup-asl-citizen.mjs; do not edit).',
    '',
    '  aslcitizen_stgcn.onnx  input x [n, 2, 128, 27] (x/y, frames, keypoints) -> logits [n, 2731]',
    '  labels.json            class index -> gloss (sorted unique Gloss values of ASL_Citizen/splits/train.csv)',
    '',
    'Source:',
    `  weights  ${WEIGHTS_URL}`,
    `           sha256 ${WEIGHTS_ZIP_SHA256} (zip), ${CHECKPOINT_SHA256} (.pt)`,
    `  labels   ${TRAIN_CSV} inside ${DATASET_URL}`,
    `  project  ${PROJECT_URL}`,
    '',
    'LICENCE: Microsoft Research licence for ASL Citizen - non-commercial research use only, NO redistribution.',
    'These files are derived from the licensed weights and data. They are gitignored on purpose:',
    'do NOT commit, upload, publish or bundle them into a distributed build. Regenerate them locally with',
    '  node scripts/setup-asl-citizen.mjs',
    '',
  ].join('\n')
  const files = [
    [MODEL_PATH, onnx],
    [LABELS_PATH, `${JSON.stringify(glosses, null, 2)}\n`],
    [README_PATH, readme],
  ]
  try {
    for (const [path, data] of files) await writeFile(`${path}.part`, data)
    for (const [path] of files) await rename(`${path}.part`, path)
  } finally {
    for (const [path] of files) await rm(`${path}.part`, { force: true })
  }
  for (const [path, data] of files) log(`saved       ${rel(path)} (${bytes(Buffer.byteLength(data))})`)

  const total = got.weights + got.datasetIndex + got.trainCsv
  log(`downloaded  ${bytes(total)} in total (weights ${bytes(got.weights)}, dataset zip index ${bytes(got.datasetIndex)},` +
    ` train.csv ${bytes(got.trainCsv)})`)
  log('ASL Citizen model ready (local use only; do not redistribute)')
}

try {
  await main()
} catch (err) {
  console.error(`[setup-asl-citizen] FAILED: ${err instanceof Error ? err.message : err}`)
  console.error('[setup-asl-citizen] Check your network and run it again, or pass local copies with --weights / --labels.')
  process.exit(1)
}
