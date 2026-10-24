import { describe, expect, it } from 'vitest'
import { getFrontmostApp, parseFrontmost } from './frontmost'

describe('parseFrontmost', () => {
  it('reads name, bundle id and window title', () => {
    expect(parseFrontmost('{"name":"Notes","bundleId":"com.apple.Notes"}', 'Groceries\n')).toEqual({
      name: 'Notes',
      bundleId: 'com.apple.Notes',
      windowTitle: 'Groceries'
    })
  })

  it('leaves out a missing or empty title and bundle id', () => {
    expect(parseFrontmost('{"name":"Finder"}', 'missing value')).toEqual({ name: 'Finder' })
    expect(parseFrontmost('{"name":"Finder","bundleId":""}', '')).toEqual({ name: 'Finder' })
  })

  it('returns null for empty or malformed output', () => {
    expect(parseFrontmost('')).toBeNull()
    expect(parseFrontmost('not json')).toBeNull()
    expect(parseFrontmost('{"bundleId":"x"}')).toBeNull()
  })
})

describe.runIf(process.platform === 'darwin')('getFrontmostApp (real, read-only)', () => {
  it('names the frontmost app and caches it briefly', async () => {
    const [a, b] = await Promise.all([getFrontmostApp(), getFrontmostApp()])
    expect(a).toBe(b) // one shared lookup
    if (!a) return // e.g. CI without a window server
    expect(a.name.length).toBeGreaterThan(0)
    expect(await getFrontmostApp()).toBe(a) // served from the ~300ms cache
  })
})
