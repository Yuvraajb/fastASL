import type * as Ort from 'onnxruntime-web'
import { assetExists } from '../assets'
import type { WorkerReply, WorkerRequest } from './model.worker'
import { SignModel, type ModelSession } from './signModel'

type OrtModule = typeof Ort

/** The Kaggle model or onnxruntime's wasm isn't next to the page: scripts/fetch-assets.mjs didn't run. */
export class MissingModelError extends Error {
  constructor() {
    super('Sign model files are missing — run npm run setup')
    this.name = 'MissingModelError'
  }
}

export const ISLR_MODEL = './models/islr1st.onnx'
export const CITIZEN_MODEL = './models/asl-citizen/aslcitizen_stgcn.onnx'
export const CITIZEN_LABELS = './models/asl-citizen/labels.json'
/** onnxruntime-web's wasm runtime, copied from node_modules by scripts/fetch-assets.mjs. */
export const ORT_DIR = './ort/'
const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']

/**
 * An ONNX model on onnxruntime-web's wasm backend. Single-threaded (no SharedArrayBuffer, so the
 * page needs no cross-origin isolation); a Kaggle-model run takes ~15 ms, an ST-GCN run ~200 ms.
 */
export async function ortSession(ort: OrtModule, model: string | Uint8Array): Promise<ModelSession> {
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' as const }
  const session = typeof model === 'string' ? await ort.InferenceSession.create(model, options) : await ort.InferenceSession.create(model, options)
  const [input] = session.inputNames
  const [output] = session.outputNames
  return {
    async run(data, dims) {
      const result = await session.run({ [input]: new ort.Tensor('float32', data, [...dims]) })
      return result[output].data as Float32Array
    }
  }
}

/** Sessions in a Web Worker (model.worker.ts): the page's main thread never waits on a model. */
async function workerSessions(wasmPaths: string, models: Record<string, string>): Promise<Record<string, ModelSession>> {
  const worker = new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module', name: 'sign-model' })
  let next = 0
  const waiting = new Map<number, { resolve: (data: Float32Array | undefined) => void; reject: (err: Error) => void }>()
  const failAll = (err: Error): void => {
    for (const w of waiting.values()) w.reject(err)
    waiting.clear()
  }
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data
    const w = waiting.get(reply.id)
    waiting.delete(reply.id)
    if (reply.ok) w?.resolve(reply.data)
    else w?.reject(new Error(reply.error))
  }
  worker.onerror = (event) => {
    event.preventDefault()
    failAll(new Error(event.message || 'the sign model worker failed to start'))
  }
  type Request = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never
  const call = (msg: Request, transfer: Transferable[] = []): Promise<Float32Array | undefined> =>
    new Promise((resolve, reject) => {
      const id = ++next
      waiting.set(id, { resolve, reject })
      worker.postMessage({ ...msg, id }, transfer)
    })
  try {
    await call({ type: 'load', wasmPaths, models })
  } catch (err) {
    worker.terminate()
    throw err
  }
  const session = (model: string): ModelSession => ({
    async run(input, dims) {
      const data = await call({ type: 'run', model, input, dims: [...dims] }, [input.buffer])
      if (!data) throw new Error(`no output from ${model}`)
      return data
    }
  })
  return Object.fromEntries(Object.keys(models).map((name) => [name, session(name)]))
}

/** The same sessions on this thread: the fallback when the worker can't start. */
async function pageSessions(wasmPaths: string, models: Record<string, string>): Promise<Record<string, ModelSession>> {
  const ort = await import('onnxruntime-web/wasm')
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = wasmPaths
  const out: Record<string, ModelSession> = {}
  for (const [name, url] of Object.entries(models)) out[name] = await ortSession(ort, url)
  return out
}

/**
 * Loads the pretrained sign models from the files next to the page (public/models, public/ort),
 * in a Web Worker when it can (else on the page's thread). The Kaggle model is required
 * (MissingModelError without it); ASL Citizen is optional and only there after
 * `npm run setup:citizen`. `log` gets a line about what loaded.
 */
export async function loadSignModel(log: (line: string) => void = () => {}): Promise<SignModel> {
  const url = (path: string): string => new URL(path, location.href).href
  const required = [url(ISLR_MODEL), ...ORT_FILES.map((f) => url(ORT_DIR + f))]
  if ((await Promise.all(required.map(assetExists))).includes(false)) throw new MissingModelError()
  const t0 = performance.now()
  let labels: string[] | null = null
  if (await assetExists(url(CITIZEN_MODEL))) {
    try {
      labels = (await (await fetch(url(CITIZEN_LABELS))).json()) as string[]
    } catch (err) {
      log(`[model] ASL Citizen labels failed to load, using the Kaggle model only (${messageOf(err)})`)
    }
  } else {
    log('[model] ASL Citizen model not installed (npm run setup:citizen): using the Kaggle model only')
  }
  const models: Record<string, string> = { islr: url(ISLR_MODEL), ...(labels ? { citizen: url(CITIZEN_MODEL) } : {}) }
  let where = 'worker'
  let sessions: Record<string, ModelSession>
  try {
    sessions = await workerSessions(url(ORT_DIR), models)
  } catch (err) {
    log(`[model] worker unavailable, running on the page (${messageOf(err)})`)
    where = 'page'
    sessions = await pageSessions(url(ORT_DIR), models)
  }
  const model = new SignModel({ islr: sessions.islr, citizen: labels && sessions.citizen ? { session: sessions.citizen, labels } : null })
  log(`[model] loaded in ${Math.round(performance.now() - t0)} ms (${where}): ${model.words.length} words${model.hasCitizen ? ' (Kaggle + ASL Citizen)' : ' (Kaggle)'}`)
  return model
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
