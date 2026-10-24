import { describe, expect, it } from 'vitest'
import { exec, readDefault } from './exec'

describe('exec', () => {
  it('passes arguments verbatim (no shell) and trims stdout', async () => {
    expect(await exec('printf', ['%s\\n', '$(whoami); `id` *'])).toBe('$(whoami); `id` *')
  })

  it('rejects with the stderr text', async () => {
    await expect(exec('ls', ['/definitely/not/here/fastasl'])).rejects.toThrow(/No such file/)
  })
})

describe.runIf(process.platform === 'darwin')('readDefault', () => {
  it('returns null for a key that is not set', async () => {
    expect(await readDefault('com.fastasl.tests.nonexistent', 'nothing')).toBeNull()
  })
})
