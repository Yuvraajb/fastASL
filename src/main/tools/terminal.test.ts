import { homedir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openTerminals = vi.fn(async (count: number, _command: string) => count)
vi.mock('../mac/terminal', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mac/terminal')>()), openTerminals }))

const { claudeCodeOpen, defaultClaudeFolder } = await import('./terminal')

describe('claude_code_open', () => {
  beforeEach(() => openTerminals.mockClear())

  it('runs in FASTASL_CLAUDE_DIR, else the home folder', () => {
    expect(defaultClaudeFolder({})).toBe(homedir())
    expect(defaultClaudeFolder({ FASTASL_CLAUDE_DIR: '~/code' })).toBe(`${homedir()}/code`)
    expect(defaultClaudeFolder({ FASTASL_CLAUDE_DIR: '/tmp' })).toBe('/tmp')
  })

  it('opens the windows running claude in the folder, and says so on the card', async () => {
    const outcome = await claudeCodeOpen.run({ count: 6, folder: '/tmp' })
    expect(openTerminals).toHaveBeenCalledTimes(1)
    const [count, command] = openTerminals.mock.calls[0]
    expect(count).toBe(6)
    expect(command).toMatch(/^cd '\/tmp' && clear && '?[^ ]*claude'?$/)
    expect(outcome).toMatchObject({ ok: true, title: 'Opened 6 Claude Code terminals', subtitle: '/tmp' })
  })

  it('refuses a folder that is not there, opening nothing', async () => {
    const outcome = await claudeCodeOpen.run({ count: 2, folder: '/no/such/folder' })
    expect(outcome).toEqual({ ok: false, text: 'No folder at /no/such/folder' })
    expect(openTerminals).not.toHaveBeenCalled()
  })

  it('is auto-approved, and caps the count', () => {
    expect(claudeCodeOpen.risk).toBe('read')
    expect(claudeCodeOpen.stepLabel({ count: 1 })).toBe('Opening 1 Claude Code terminal')
  })
})
