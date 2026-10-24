import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appPath, googleSearchUrl, openApp, screenshotFileName, takeScreenshot, webSearch } from './apps'
import { exec } from './exec'
import { MacError } from './osascript'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./exec', () => ({ exec: vi.fn() }))

const execMock = vi.mocked(exec)

beforeEach(() => {
  execMock.mockReset()
})

describe('screenshotFileName', () => {
  it('matches the macOS naming style with zero padding', () => {
    expect(screenshotFileName(new Date(2026, 9, 4, 9, 3, 7))).toBe('fastASL Screenshot 2026-10-04 at 09.03.07.png')
  })

  it('adds a copy number for collisions', () => {
    expect(screenshotFileName(new Date(2026, 9, 24, 14, 0, 0), 2)).toBe('fastASL Screenshot 2026-10-24 at 14.00.00 (2).png')
  })
})

describe('takeScreenshot', () => {
  const at = new Date(2026, 9, 24, 14, 3, 22)

  it('captures silently to the Desktop folder and returns the verified path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fastasl-shot-'))
    execMock.mockImplementation(async (_cmd, args) => {
      writeFileSync(args[1], 'png-bytes')
      return ''
    })
    const path = await takeScreenshot(at, dir)
    expect(path).toBe(join(dir, 'fastASL Screenshot 2026-10-24 at 14.03.22.png'))
    expect(execMock).toHaveBeenCalledWith('screencapture', ['-x', path], 15_000)
  })

  it('never overwrites an existing screenshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fastasl-shot-'))
    writeFileSync(join(dir, screenshotFileName(at)), 'old')
    execMock.mockImplementation(async (_cmd, args) => {
      writeFileSync(args[1], 'new')
      return ''
    })
    expect(await takeScreenshot(at, dir)).toBe(join(dir, screenshotFileName(at, 2)))
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('explains the Screen Recording permission when no image is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fastasl-shot-'))
    execMock.mockResolvedValue('')
    const err = await takeScreenshot(at, dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MacError)
    expect((err as MacError).kind).toBe('screen-recording')
    expect((err as MacError).message).toBe(
      'Allow fastASL in System Settings › Privacy & Security › Screen & System Audio Recording'
    )
  })

  it('treats an empty file as a failed capture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fastasl-shot-'))
    execMock.mockImplementation(async (_cmd, args) => {
      writeFileSync(args[1], '')
      return ''
    })
    await expect(takeScreenshot(at, dir)).rejects.toMatchObject({ kind: 'screen-recording' })
  })
})

describe('openApp', () => {
  it('uses open -a without a shell', async () => {
    execMock.mockResolvedValue('')
    await openApp('Calendar; rm -rf ~')
    expect(execMock).toHaveBeenCalledWith('open', ['-a', 'Calendar; rm -rf ~'])
  })

  it('reports a missing app by name', async () => {
    execMock.mockRejectedValue(new Error("Unable to find application named 'Fooapp'"))
    await expect(openApp('Fooapp')).rejects.toMatchObject({ kind: 'not-installed', message: "Fooapp isn't installed" })
  })
})

describe('web search', () => {
  it('encodes the query', () => {
    expect(googleSearchUrl('  cats & dogs #1 ')).toBe('https://www.google.com/search?q=cats%20%26%20dogs%20%231')
    expect(googleSearchUrl('café?')).toBe('https://www.google.com/search?q=caf%C3%A9%3F')
  })

  it('opens the search in the default browser', async () => {
    expect(await webSearch('weather')).toBe('https://www.google.com/search?q=weather')
    expect(shell.openExternal).toHaveBeenCalledWith('https://www.google.com/search?q=weather')
  })
})

describe.runIf(process.platform === 'darwin')('appPath (real LaunchServices lookup)', () => {
  it('finds a system app and returns null for an unknown bundle id', async () => {
    expect(await appPath('com.apple.finder')).toMatch(/Finder\.app$/)
    expect(await appPath('com.example.not-installed.fastasl')).toBeNull()
  })
})
