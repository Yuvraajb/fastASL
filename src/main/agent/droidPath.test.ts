import { describe, expect, it } from 'vitest'
import { INSTALL_DROID, resolveDroidPath, type DroidPathDeps } from './droidPath'

function deps(executables: string[], overrides: Partial<DroidPathDeps> = {}): DroidPathDeps {
  return {
    env: {},
    home: '/Users/me',
    isExecutable: async (path) => executables.includes(path),
    loginShellLookup: async () => '',
    ...overrides
  }
}

describe('resolveDroidPath', () => {
  it('uses FACTORY_DROID_PATH first', async () => {
    const result = await resolveDroidPath(
      deps(['/custom/droid', '/opt/homebrew/bin/droid'], { env: { FACTORY_DROID_PATH: '/custom/droid' } })
    )
    expect(result).toEqual({ ok: true, value: '/custom/droid' })
  })

  it('reports a FACTORY_DROID_PATH that is not executable', async () => {
    const result = await resolveDroidPath(deps([], { env: { FACTORY_DROID_PATH: '/nope/droid' } }))
    expect(result).toEqual({ ok: false, error: `FACTORY_DROID_PATH (/nope/droid) is not an executable. ${INSTALL_DROID}` })
  })

  it('takes the last absolute line from the login shell', async () => {
    const result = await resolveDroidPath(
      deps(['/Users/me/bin/droid'], { loginShellLookup: async () => 'Welcome back!\n/Users/me/bin/droid\n' })
    )
    expect(result).toEqual({ ok: true, value: '/Users/me/bin/droid' })
  })

  it('falls back to the usual install locations', async () => {
    const result = await resolveDroidPath(deps(['/Users/me/.local/bin/droid', '/opt/homebrew/bin/droid']))
    expect(result).toEqual({ ok: true, value: '/Users/me/.local/bin/droid' })
  })

  it('asks for an install when nothing is found', async () => {
    expect(await resolveDroidPath(deps([]))).toEqual({ ok: false, error: INSTALL_DROID })
  })
})
