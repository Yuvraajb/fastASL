import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        // onnxruntime-web's build without the wasm bundled: it loads ort-wasm-simd-threaded.{mjs,wasm}
        // from ort.env.wasm.wasmPaths (public/ort, copied by scripts/fetch-assets.mjs). Its default
        // build names the wasm with new URL(..., import.meta.url), which made Vite copy 14 MB more
        // into every build.
        'onnxruntime-web/wasm': resolve('node_modules/onnxruntime-web/dist/ort.wasm.min.mjs')
      }
    },
    // The sign model's worker (engine/model/model.worker.ts) is an ES module, like the page.
    worker: { format: 'es' },
    plugins: [react()]
  }
})
