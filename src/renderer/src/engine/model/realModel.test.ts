/**
 * The pretrained models themselves, run in Node with onnxruntime-web on REAL landmark sequences
 * (ASL Citizen signers, unseen by the Kaggle model). Skips unless FASTASL_SIGN_DATA points at a
 * local data folder (evalData.ts) and the models are installed; ASL Citizen's data can't be
 * committed. FASTASL_SIGN_EVAL=1 also prints the calibration report behind DECISIONS.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FrameSample } from '../types'
import { describeTop } from './decide'
import { evalIndex, handWindow, loadFrames, wordForGloss, type EvalEntry } from './evalData'
import { citizenInput, CITIZEN_FRAMES, CITIZEN_KEYPOINTS, islrInput, ISLR_POINTS } from './inputs'
import { ortSession } from './runtime'
import { CITIZEN_PAD, ISLR_PAD, padded, SignModel, type ModelSession, type ModelVerdict } from './signModel'
import { SIGN_VOCABULARY, type SignWord } from './vocabulary'

const DATA = process.env.FASTASL_SIGN_DATA
const ISLR = resolve('src/renderer/public/models/islr1st.onnx')
const CITIZEN = resolve(process.env.FASTASL_CITIZEN_MODEL ?? 'src/renderer/public/models/asl-citizen/aslcitizen_stgcn.onnx')
const CITIZEN_LABELS = resolve(process.env.FASTASL_CITIZEN_LABELS ?? 'src/renderer/public/models/asl-citizen/labels.json')
const index = evalIndex(DATA)
const ready = index !== null && existsSync(ISLR)

async function nodeSession(path: string): Promise<ModelSession> {
  const ort = await import('onnxruntime-web/wasm')
  ort.env.wasm.numThreads = 1
  return ortSession(ort, readFileSync(path))
}

describe.skipIf(!ready)('pretrained sign model on real signers (local data)', () => {
  it('names HELLO, THANK YOU and WATER from real landmark sequences, through the app’s input building', async () => {
    const model = new SignModel({ islr: await nodeSession(ISLR) })
    for (const gloss of ['HELLO', 'THANKYOU', 'WATER']) {
      const entries = index!.filter((e) => e.gloss.replace(/_/g, '') === gloss).slice(0, 6)
      expect(entries.length).toBeGreaterThan(0)
      let right = 0
      for (const entry of entries) {
        const verdict = await model.classify(handWindow(loadFrames(DATA!, entry)))
        console.log(`[model] ${gloss} ${entry.name}: ${describeTop(verdict.islr!.ranked)} -> ${verdict.decision.status} (${verdict.ms.toFixed(0)} ms, face ${verdict.face})`)
        if (verdict.decision.status === 'accepted' && verdict.decision.word === wordForGloss(gloss)) right++
      }
      expect(right / entries.length).toBeGreaterThanOrEqual(0.8)
    }
  }, 120_000)
})

// ------------------------------------------------------------------------- calibration report

interface Cached {
  name: string
  word: string | null
  islr: [number[], number[]]
  citizen: [number[], number[]] | null
}

/** A session that answers from cached logits, in the order SignModel asks (as tracked, then swapped). */
function replay(outputs: number[][]): ModelSession {
  let i = 0
  return { run: async () => Float32Array.from(outputs[i++]) }
}

async function cacheLogits(entries: EvalEntry[]): Promise<Cached[]> {
  const cachePath = process.env.FASTASL_SIGN_EVAL_CACHE
  if (cachePath && existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8')) as Cached[]
  const islr = await nodeSession(ISLR)
  const citizen = existsSync(CITIZEN) ? await nodeSession(CITIZEN) : null
  const out: Cached[] = []
  for (const entry of entries) {
    const window = handWindow(loadFrames(DATA!, entry))
    const frames = padded(window, ISLR_PAD)
    const around = padded(window, CITIZEN_PAD)
    const dims = [frames.length, ISLR_POINTS, 3]
    const run = async (s: ModelSession, x: Float32Array, d: number[]): Promise<number[]> => Array.from(await s.run(x, d))
    const cdims = [1, 2, CITIZEN_FRAMES, CITIZEN_KEYPOINTS.length]
    out.push({
      name: entry.name,
      word: wordForGloss(entry.gloss),
      islr: [await run(islr, islrInput(frames), dims), await run(islr, islrInput(frames, true), dims)],
      citizen: citizen ? [await run(citizen, citizenInput(around), cdims), await run(citizen, citizenInput(around, true), cdims)] : null
    })
  }
  if (cachePath) writeFileSync(cachePath, JSON.stringify(out))
  return out
}

async function verdictFor(c: Cached, vocabulary: readonly SignWord[], labels: string[] | null): Promise<ModelVerdict> {
  const model = new SignModel({
    islr: replay(c.islr),
    citizen: labels && c.citizen ? { session: replay([[...c.citizen[0], ...c.citizen[1]]]), labels } : null,
    vocabulary
  })
  // The frames only need hands and pose for classify() to run the models; the logits are cached.
  const frame: FrameSample = { t: 0, hands: [{ landmarks: [{ x: 0.5, y: 0.5, z: 0 }], handedness: 'Left', score: 1 }], pose: Array(33).fill({ x: 0.5, y: 0.5, z: 0 }) }
  return model.classify([frame])
}

interface Tally {
  n: number
  correct: number
  wrong: number
  ambiguous: number
  rejected: number
}

async function report(cached: Cached[], vocabulary: readonly SignWord[], labels: string[] | null, title: string): Promise<void> {
  const known = new SignModel({ islr: replay([]), citizen: labels ? { session: replay([]), labels } : null, vocabulary }).words
  const perWord = new Map<string, Tally>()
  const total: Tally = { n: 0, correct: 0, wrong: 0, ambiguous: 0, rejected: 0 }
  for (const c of cached) {
    if (!c.word || !known.includes(c.word)) continue
    const v = await verdictFor(c, vocabulary, labels)
    const t = perWord.get(c.word) ?? { n: 0, correct: 0, wrong: 0, ambiguous: 0, rejected: 0 }
    for (const x of [t, total]) {
      x.n++
      if (v.decision.status === 'accepted') x[v.decision.word === c.word ? 'correct' : 'wrong']++
      else x[v.decision.status]++
    }
    perWord.set(c.word, t)
  }
  // Leave one out: each word disabled in turn, its own signs are out of vocabulary.
  let oovN = 0
  let oovAccepted = 0
  for (const word of perWord.keys()) {
    const without = vocabulary.map((w) => (w.word === word ? { ...w, enabled: false } : w))
    for (const c of cached.filter((x) => x.word === word)) {
      oovN++
      if ((await verdictFor(c, without, labels)).decision.status === 'accepted') oovAccepted++
    }
  }
  const pct = (a: number, n: number): string => `${((100 * a) / Math.max(1, n)).toFixed(0)}%`
  console.log(`\n=== ${title}: ${known.length} words enabled`)
  for (const [word, t] of [...perWord].sort()) {
    console.log(`  ${word.padEnd(10)} n=${String(t.n).padStart(2)} correct ${pct(t.correct, t.n).padStart(4)} wrong ${pct(t.wrong, t.n).padStart(4)} did-you-mean ${pct(t.ambiguous, t.n).padStart(4)} rejected ${pct(t.rejected, t.n).padStart(4)}`)
  }
  console.log(`  TOTAL n=${total.n} correct ${pct(total.correct, total.n)} wrong ${pct(total.wrong, total.n)} did-you-mean ${pct(total.ambiguous, total.n)} rejected ${pct(total.rejected, total.n)}`)
  console.log(`  out of vocabulary (each word left out in turn): accepted as another word ${pct(oovAccepted, oovN)} of ${oovN}`)
}

describe.skipIf(!ready || process.env.FASTASL_SIGN_EVAL !== '1')('calibration report (FASTASL_SIGN_EVAL=1)', () => {
  it('prints per-word accuracy and out-of-vocabulary accepts', async () => {
    const cached = await cacheLogits(index!)
    const labels = existsSync(CITIZEN_LABELS) ? (JSON.parse(readFileSync(CITIZEN_LABELS, 'utf8')) as string[]) : null
    await report(cached, SIGN_VOCABULARY, null, 'Kaggle model only')
    if (labels) await report(cached, SIGN_VOCABULARY, labels, 'Kaggle + ASL Citizen')
  }, 1_800_000)
})
