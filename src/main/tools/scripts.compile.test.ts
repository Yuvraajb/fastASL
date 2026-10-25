import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRONT_APP_SCRIPT, FRONT_WINDOW_SCRIPT } from '../mac/frontmost'
import { pasteScript } from '../mac/typeText'
import { createEventScript, listEventsScript } from './calendar'
import { contactSearchScript } from './contacts'
import { darkModeScript, timerScript } from './controls'
import { sendMailScript } from './mail'
import { sendMessageScript } from './messages'
import { readNoteScript, searchNotesScript } from './notes'
import { PAUSE_SCRIPT, playScript } from './spotify'

// `osacompile` checks every generated script against the real app
// dictionaries without running it or launching the app, so nothing is sent,
// created or played.

const dir = process.platform === 'darwin' ? mkdtempSync(join(tmpdir(), 'fastasl-osa-')) : ''
let n = 0

function compile(script: string, language: 'AppleScript' | 'JavaScript' = 'AppleScript'): Promise<string> {
  const out = join(dir, `s${n++}.scpt`)
  return new Promise((resolve) => {
    execFile('osacompile', ['-l', language, '-o', out, '-e', script], (err, _stdout, stderr) =>
      resolve(err ? stderr.trim() || err.message : '')
    )
  })
}

const hostile = 'He said "hi" \\ “quoted” \n line two \u0000 end'
const start = new Date(2026, 9, 25, 10, 0)
const end = new Date(2026, 9, 25, 11, 0)

describe.runIf(process.platform === 'darwin')('generated scripts compile against the real dictionaries', () => {
  const appleScripts: Record<string, string> = {
    'calendar list': listEventsScript({ start, end }),
    'calendar create': createEventScript({
      title: hostile,
      start,
      end,
      attendees: ['a@example.com', 'b@example.com'],
      notes: hostile,
      videoLink: 'https://meet.google.com/abc-defg-hij',
      calendarId: '08B97B3F-9CB5-435C-8A92-CF2F2AD52014'
    }),
    'calendar create (minimal)': createEventScript({ title: 'x', start, end, attendees: [], notes: '' }),
    'mail send': sendMailScript({ to: ['a@example.com', 'b@example.com'], subject: hostile, body: hostile }),
    'mail send (attachment)': sendMailScript({ to: ['a@example.com'], subject: 'x', body: 'y', attachments: ['/Users/me/Documents/My "CV".pdf'] }),
    'dark mode on': darkModeScript('on'),
    'dark mode toggle': darkModeScript('toggle'),
    'timer notification': timerScript(hostile),
    'message send': sendMessageScript('+15550102000', hostile),
    'contacts search': contactSearchScript(hostile),
    'notes search': searchNotesScript(hostile),
    'notes read': readNoteScript(hostile),
    'front window': FRONT_WINDOW_SCRIPT
  }

  for (const [name, script] of Object.entries(appleScripts)) {
    it(name, async () => {
      expect(await compile(script)).toBe('')
    })
  }

  it.runIf(existsSync('/Applications/Spotify.app'))('spotify play / pause', async () => {
    expect(await compile(playScript('spotify:track:5xo8RrjJ9CVNrtRg2S3B1R'))).toBe('')
    expect(await compile(playScript('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'))).toBe('')
    expect(await compile(PAUSE_SCRIPT)).toBe('')
  })

  it('JXA scripts', async () => {
    expect(await compile(pasteScript(hostile), 'JavaScript')).toBe('')
    expect(await compile(FRONT_APP_SCRIPT, 'JavaScript')).toBe('')
  })

  it('reports a real syntax error (sanity check)', async () => {
    expect(await compile('tell application "Calendar" to frobnicate x x')).toMatch(/error/i)
  })
})
