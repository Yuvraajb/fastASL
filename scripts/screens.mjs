#!/usr/bin/env node
// Render mock card states to docs/screens/NN-<id>.png.
//   node scripts/screens.mjs                 -> every state in SCREENSHOT_ORDER
//   node scripts/screens.mjs ready,confirm   -> only those ids
// Each run builds into its own temp outDir, so several runs can happen in parallel.
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const only = process.argv[2] ?? ''
const outDir = join('out-screens', `${process.pid}`)
const bin = (name) => join('node_modules', '.bin', name)

const build = spawnSync(bin('electron-vite'), ['build', '--outDir', outDir, '--logLevel', 'error'], {
  stdio: 'inherit'
})
if (build.status !== 0) process.exit(build.status ?? 1)

const run = spawnSync(bin('electron'), [join(outDir, 'main', 'index.js')], {
  stdio: 'inherit',
  timeout: 120_000,
  env: { ...process.env, FASTASL_SCREENSHOTS: '1', FASTASL_SCREENS_ONLY: only }
})
rmSync(outDir, { recursive: true, force: true })
process.exit(run.status ?? 0)
