import { describe, expect, it } from 'vitest'
import { claudeCommandPath, gridColumns, shellQuote, terminalScript } from './terminal'

describe('terminal', () => {
  it('finds the claude CLI where the installer puts it, else uses the bare name', () => {
    expect(claudeCommandPath((p) => p === '/Users/me/.local/bin/claude', '/Users/me')).toBe('/Users/me/.local/bin/claude')
    expect(claudeCommandPath((p) => p === '/opt/homebrew/bin/claude', '/Users/me')).toBe('/opt/homebrew/bin/claude')
    expect(claudeCommandPath(() => false, '/Users/me')).toBe('claude')
  })

  it('quotes a folder for the shell, quotes inside it too', () => {
    expect(shellQuote('/Users/me/My Projects')).toBe("'/Users/me/My Projects'")
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'")
  })

  it('tiles up to 3 windows in a row, more in two rows', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(gridColumns)).toEqual([1, 2, 3, 2, 3, 3, 4, 4])
  })

  it('opens each window with the command as a JS string literal, in a 3x2 grid for 6', () => {
    const script = terminalScript(6, "cd '/Users/me' && claude")
    expect(script).toContain('T.doScript("cd \'/Users/me\' && claude")')
    expect(script).toContain('for (let i = 0; i < 6; i++)')
    expect(script).toContain('vis.size.width / 3')
    expect(script).toContain('vis.size.height / 2')
  })
})
