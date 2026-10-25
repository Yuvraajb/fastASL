import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exec } from '../mac/exec'
import { runAppleScript } from '../mac/osascript'
import { darkModeScript, lockScreen, setDarkMode, setTimer, setVolume, timerScript } from './controls'

vi.mock('../mac/exec', () => ({ exec: vi.fn(async () => '') }))
vi.mock('../mac/osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/osascript')>()),
  runAppleScript: vi.fn(async () => '')
}))

const runMock = vi.mocked(runAppleScript)
const execMock = vi.mocked(exec)

beforeEach(() => {
  runMock.mockReset()
  runMock.mockResolvedValue('')
  execMock.mockReset()
  vi.useRealTimers()
})

describe('set_volume', () => {
  it('sets the output volume', async () => {
    expect(await setVolume.run({ level: 30 })).toMatchObject({ ok: true, title: 'Volume 30' })
    expect(runMock).toHaveBeenCalledWith('set volume output volume 30')
    expect(await setVolume.run({ level: 0 })).toMatchObject({ title: 'Muted' })
  })
})

describe('set_dark_mode', () => {
  it('builds the System Events line per mode', () => {
    expect(darkModeScript('on')).toContain('set dark mode to true')
    expect(darkModeScript('off')).toContain('set dark mode to false')
    expect(darkModeScript('toggle')).toContain('set dark mode to not dark mode')
  })

  it('reports the appearance it ends up in', async () => {
    runMock.mockResolvedValueOnce('').mockResolvedValueOnce('true')
    expect(await setDarkMode.run({ mode: 'on' })).toMatchObject({ ok: true, title: 'Dark mode on' })
    runMock.mockResolvedValueOnce('').mockResolvedValueOnce('false')
    expect(await setDarkMode.run({ mode: 'off' })).toMatchObject({ title: 'Light mode on' })
  })
})

describe('set_timer', () => {
  it('shows a notification when the time is up', async () => {
    vi.useFakeTimers()
    const out = await setTimer.run({ minutes: 5, label: 'Tea' })
    expect(out).toMatchObject({ ok: true, title: 'Timer: 5 minutes', subtitle: 'Tea' })
    expect(runMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(runMock).toHaveBeenCalledWith(timerScript('Tea'))
  })

  it('words short timers in seconds', async () => {
    vi.useFakeTimers()
    expect((await setTimer.run({ minutes: 0.5 })).title).toBe('Timer: 30 seconds')
  })
})

describe('lock_screen', () => {
  it('needs a confirmation, then turns the display off', async () => {
    expect(lockScreen.risk).toBe('write')
    expect(lockScreen.confirmDetails?.({}).kind).toBe('generic')
    expect(await lockScreen.run({})).toMatchObject({ ok: true, title: 'Screen locked' })
    expect(execMock).toHaveBeenCalledWith('pmset', ['displaysleepnow'], 5000)
  })

  it('fails with the reason when the command does', async () => {
    execMock.mockRejectedValueOnce(new Error('not permitted'))
    expect(await lockScreen.run({})).toEqual({ ok: false, text: 'not permitted' })
  })
})
