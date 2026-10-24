/// <reference lib="webworker" />
/**
 * The sign models' inference, off the page's main thread: an ASL Citizen run takes ~200 ms per
 * input, which would stall the camera loop and the card. runtime.ts talks to it (workerSession)
 * and falls back to running in the page when the worker can't start.
 */
import * as ort from 'onnxruntime-web/wasm'

export type WorkerRequest =
  | { type: 'load'; id: number; wasmPaths: string; models: Record<string, string> }
  | { type: 'run'; id: number; model: string; input: Float32Array; dims: number[] }

export type WorkerReply = { id: number; ok: true; data?: Float32Array } | { id: number; ok: false; error: string }

const scope = self as unknown as DedicatedWorkerGlobalScope
const sessions = new Map<string, ort.InferenceSession>()

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  try {
    if (msg.type === 'load') {
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      ort.env.wasm.wasmPaths = msg.wasmPaths
      for (const [name, url] of Object.entries(msg.models)) {
        sessions.set(name, await ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }))
      }
      scope.postMessage({ id: msg.id, ok: true } satisfies WorkerReply)
      return
    }
    const session = sessions.get(msg.model)
    if (!session) throw new Error(`model ${msg.model} is not loaded`)
    const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', msg.input, msg.dims) })
    const data = Float32Array.from(result[session.outputNames[0]].data as Float32Array)
    scope.postMessage({ id: msg.id, ok: true, data } satisfies WorkerReply, [data.buffer])
  } catch (err) {
    scope.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerReply)
  }
}
