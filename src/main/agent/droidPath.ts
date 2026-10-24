import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Result } from '@shared/types'

export const INSTALL_DROID = 'Install the droid CLI: brew install --cask droid'

export interface DroidPathDeps {
  env: Record<string, string | undefined>
  home: string
  isExecutable(path: string): Promise<boolean>
  /** Output of `command -v droid` in the user's login shell (apps opened from Finder get a minimal PATH). */
  loginShellLookup(): Promise<string>
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function loginShellLookup(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', 'command -v droid'], { timeout: 4000 }, (_error, stdout) => resolve(stdout ?? ''))
  })
}

const defaults: DroidPathDeps = { env: process.env, home: homedir(), isExecutable, loginShellLookup }

/** Finds the droid CLI: FACTORY_DROID_PATH, then the login shell, then the usual install locations. */
export async function resolveDroidPath(deps: DroidPathDeps = defaults): Promise<Result<string>> {
  const configured = deps.env.FACTORY_DROID_PATH?.trim()
  if (configured) {
    return (await deps.isExecutable(configured))
      ? { ok: true, value: configured }
      : { ok: false, error: `FACTORY_DROID_PATH (${configured}) is not an executable. ${INSTALL_DROID}` }
  }

  // Login shells can print banners; the path is the last absolute line.
  const fromShell = (await deps.loginShellLookup())
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
    .at(-1)
  const candidates = [
    ...(fromShell ? [fromShell] : []),
    join(deps.home, '.local/bin/droid'),
    join(deps.home, '.factory/bin/droid'),
    '/opt/homebrew/bin/droid',
    '/usr/local/bin/droid'
  ]
  for (const path of candidates) {
    if (await deps.isExecutable(path)) return { ok: true, value: path }
  }
  return { ok: false, error: INSTALL_DROID }
}
