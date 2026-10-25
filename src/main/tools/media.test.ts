import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appPath } from '../mac/apps'
import { SEP, runAppleScript } from '../mac/osascript'
import { mediaControl, mediaOutcome, mediaScript } from './media'

vi.mock('../mac/apps', () => ({ appPath: vi.fn() }))
// Nothing is ever played: every AppleScript call is answered by this mock.
vi.mock('../mac/osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/osascript')>()),
  runAppleScript: vi.fn()
}))

const runMock = vi.mocked(runAppleScript)
const appPathMock = vi.mocked(appPath)
const reply = (...fields: string[]): string => fields.join(SEP.field)

beforeEach(() => {
  runMock.mockReset()
  appPathMock.mockReset()
})

describe('mediaScript', () => {
  it('prefers the player that is playing, then one that is open', () => {
    const script = mediaScript('pause', ['Spotify', 'Music'])
    const playing = script.indexOf('if player state is playing then set target to "Spotify"')
    const musicPlaying = script.indexOf('if player state is playing then set target to "Music"')
    const open = script.indexOf('if target is "" and application "Spotify" is running then set target to "Spotify"')
    expect(playing).toBeGreaterThan(-1)
    expect(musicPlaying).toBeGreaterThan(playing)
    expect(open).toBeGreaterThan(musicPlaying)
  })

  it('launches a player only to play', () => {
    expect(mediaScript('play', ['Spotify', 'Music'])).toContain('if target is "" then set target to "Spotify"')
    expect(mediaScript('play', ['Music'])).toContain('if target is "" then set target to "Music"')
    for (const action of ['pause', 'next', 'previous'] as const) {
      expect(mediaScript(action, ['Spotify', 'Music'])).not.toMatch(/if target is "" then set target/)
    }
  })

  it('sends the right command and waits for it to take effect', () => {
    expect(mediaScript('next', ['Music'])).toContain('\t\tnext track\n')
    expect(mediaScript('next', ['Music'])).toContain('if (name of current track) is not beforeName then exit repeat')
    expect(mediaScript('pause', ['Music'])).toContain('if player state is not playing then exit repeat')
    expect(mediaScript('previous', ['Music'])).toContain('\t\tprevious track\n')
  })

  it('leaves out apps that are not installed (their terminology would not compile)', () => {
    expect(mediaScript('play', ['Music'])).not.toContain('Spotify')
  })
})

describe('mediaOutcome', () => {
  it('reports what is really playing', () => {
    expect(mediaOutcome('play', reply('Spotify', 'playing', 'More Than A Woman', 'Bee Gees'))).toEqual({
      ok: true,
      text: 'Spotify is playing More Than A Woman by Bee Gees.',
      title: 'Playing More Than A Woman',
      subtitle: 'Bee Gees · Spotify',
      view: { kind: 'openApp', app: 'Spotify' }
    })
    expect(mediaOutcome('next', reply('Music', 'playing', 'Song 2', ''))).toMatchObject({
      ok: true,
      text: 'Music is playing Song 2.',
      subtitle: 'Music'
    })
  })

  it('fails when the player did not do it', () => {
    expect(mediaOutcome('play', reply('Spotify', 'paused', 'Song', ''))).toEqual({
      ok: false,
      text: "Spotify didn't start playing. Make sure you are signed in to Spotify."
    })
    // Seen on a real Mac: Spotify stopped with no current track ignores play.
    expect(mediaOutcome('play', reply('Spotify', 'stopped', '', '')).text).toBe(
      "Spotify didn't start playing. Spotify has nothing to resume: play a song in Spotify once, or ask for a particular song."
    )
    expect(mediaOutcome('play', reply('Music', 'stopped', '', '')).text).toContain('Choose something to play in Music')
    expect(mediaOutcome('pause', reply('Music', 'playing', 'x', ''))).toEqual({ ok: false, text: 'Music kept playing' })
    expect(mediaOutcome('next', reply('Spotify', 'paused', 'x', '')).ok).toBe(false)
    expect(mediaOutcome('play', '').ok).toBe(false)
  })

  it('pauses, and says so when nothing was playing', () => {
    expect(mediaOutcome('pause', reply('Spotify', 'paused', 'Motion Sickness', 'Phoebe Bridgers'))).toEqual({
      ok: true,
      text: 'Paused Motion Sickness by Phoebe Bridgers in Spotify.',
      title: 'Paused Spotify',
      subtitle: 'Motion Sickness'
    })
    expect(mediaOutcome('pause', 'none')).toMatchObject({ ok: true, title: 'Nothing playing' })
  })
})

describe('media_control', () => {
  it('uses only the installed players', async () => {
    appPathMock.mockImplementation(async (id) => (id === 'com.apple.Music' ? '/System/Applications/Music.app' : null))
    runMock.mockResolvedValue(reply('Music', 'playing', 'Song', 'Band'))
    expect(await mediaControl.run({ action: 'play' })).toMatchObject({ ok: true, title: 'Playing Song' })
    expect(runMock.mock.calls[0][0]).not.toContain('Spotify')
  })

  it('fails clearly with no player at all', async () => {
    appPathMock.mockResolvedValue(null)
    expect(await mediaControl.run({ action: 'play' })).toEqual({ ok: false, text: 'Neither Spotify nor Music is installed' })
    expect(runMock).not.toHaveBeenCalled()
  })

  it('has short step labels', () => {
    expect(mediaControl.stepLabel({ action: 'next' })).toBe('Skipping to next song')
  })
})

// `osacompile` checks the scripts against the real app dictionaries without running them.
const compile = (script: string): Promise<string> => {
  const out = join(mkdtempSync(join(tmpdir(), 'fastasl-media-')), 's.scpt')
  return new Promise((resolve) =>
    execFile('osacompile', ['-o', out, '-e', script], (err, _o, stderr) => resolve(err ? stderr.trim() || err.message : ''))
  )
}

describe.runIf(process.platform === 'darwin')('media scripts compile against the real dictionaries', () => {
  it.runIf(existsSync('/System/Applications/Music.app'))('Music', async () => {
    for (const action of ['play', 'pause', 'next', 'previous'] as const) expect(await compile(mediaScript(action, ['Music']))).toBe('')
  })

  it.runIf(existsSync('/Applications/Spotify.app'))('Spotify and Music', async () => {
    for (const action of ['play', 'pause', 'next', 'previous'] as const) {
      expect(await compile(mediaScript(action, ['Spotify', 'Music']))).toBe('')
    }
  })
})
