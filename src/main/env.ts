import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import dotenv from 'dotenv'
import type { EnvKey, KeyStatus } from '@shared/types'
import { dataDir } from './store'

const KEYS: EnvKey[] = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'FACTORY_API_KEY',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET'
]

/** Load .env from the project root (dev) or the app data dir (installed). Never throws. */
export function loadEnv(): void {
  const candidates = [join(app.getAppPath(), '.env'), join(process.cwd(), '.env'), join(dataDir(), '.env')]
  for (const path of candidates) {
    if (existsSync(path)) {
      dotenv.config({ path, quiet: true, override: false })
    }
  }
}

export function getKey(key: EnvKey): string | undefined {
  const value = process.env[key]?.trim()
  return value ? value : undefined
}

export function keyStatus(): KeyStatus {
  const status = {} as KeyStatus
  for (const key of KEYS) status[key] = Boolean(getKey(key))
  return status
}

export function missingKeyMessage(key: EnvKey): string {
  return `Add ${key} to .env`
}
