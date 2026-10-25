import { describe, expect, it, vi } from 'vitest'
import {
  MacError,
  SEP,
  appleScriptString,
  cleanOsaMessage,
  jsString,
  osaError,
  retryWhenNotRunning,
  runAppleScript,
  runJxa,
  splitRecords
} from './osascript'

const onMac = process.platform === 'darwin'

// Inputs that would change the script's meaning if they escaped the literal.
const HOSTILE = [
  '',
  'plain text',
  'say "hi"',
  'back\\slash',
  'trailing backslash \\',
  '\\"',
  '" & "INJECTED',
  '"; return "INJECTED"; "',
  '" & (system info) & "',
  'line one\nline two',
  'carriage\rreturn',
  'tab\there',
  'crlf\r\nend',
  'null\u0000byte',
  'bell\u0007 and esc\u001b[0m',
  'del\u007f',
  'sep\u2028line\u2029para',
  'curly “quotes” and ‘single’',
  '¬ continuation ¬\nnext',
  '«data utxt0041» chevrons',
  '-- comment (* block *)',
  'emoji 👋🏽 and 中文 and é',
  'end tell\nend run'
]

describe('appleScriptString', () => {
  it('wraps plain text in quotes', () => {
    expect(appleScriptString('hello')).toBe('"hello"')
    expect(appleScriptString('')).toBe('""')
  })

  it('escapes quotes, backslashes and whitespace', () => {
    expect(appleScriptString('a"b')).toBe('"a\\"b"')
    expect(appleScriptString('a\\b')).toBe('"a\\\\b"')
    expect(appleScriptString('a\nb\rc\td')).toBe('"a\\nb\\rc\\td"')
  })

  it('splices other control characters with character id, parenthesized', () => {
    expect(appleScriptString('a\u0000b')).toBe('("a" & (character id 0) & "b")')
    expect(appleScriptString('x\u2028')).toBe('("x" & (character id 8232) & "")')
  })

  it('keeps unicode as-is and replaces lone surrogates', () => {
    expect(appleScriptString('👋 é “q”')).toBe('"👋 é “q”"')
    expect(appleScriptString('a\ud800b')).toBe('"a\ufffdb"')
  })

  it('never emits a raw newline, NUL or unescaped quote', () => {
    for (const input of HOSTILE) {
      const literal = appleScriptString(input)
      expect(literal).not.toMatch(/[\n\r\u0000\u2028\u2029]/)
      // Every quote inside the literal is either escaped or part of a splice.
      const body = literal.replace(/^\(?"|"\)?$/g, '').replace(/" & \(character id \d+\) & "/g, '')
      expect(body).not.toMatch(/(^|[^\\])(\\\\)*"/)
    }
  })

  it.runIf(onMac)('round-trips every hostile input through real AppleScript unchanged', async () => {
    for (const input of HOSTILE) {
      const out = await runAppleScript(`return ${appleScriptString(input)}`)
      expect(out).toBe(input)
    }
  })

  it.runIf(onMac)('is safe inside a larger expression (precedence)', async () => {
    const literal = appleScriptString('b\u0000')
    expect(await runAppleScript(`return ${appleScriptString('ab\u0000c')} contains ${literal}`)).toBe('true')
    expect(await runAppleScript(`return (length of ${literal}) as text`)).toBe('2')
  })
})

describe('jsString', () => {
  it('escapes line separators that older JS engines treat as newlines', () => {
    expect(jsString('a\u2028b')).toBe('"a\\u2028b"')
    expect(jsString('q"\\')).toBe('"q\\"\\\\"')
  })

  it.runIf(onMac)('round-trips hostile input through real JXA unchanged', async () => {
    for (const input of [...HOSTILE.filter((s) => !s.includes('\u0000')), '"); throw new Error("x"); ("', '${1+1}`']) {
      expect(await runJxa(jsString(input))).toBe(input)
    }
  })
})

describe('splitRecords', () => {
  it('splits records and fields, empty output -> none', () => {
    expect(splitRecords('')).toEqual([])
    expect(splitRecords(`a${SEP.field}b${SEP.record}c${SEP.field}`)).toEqual([
      ['a', 'b'],
      ['c', '']
    ])
  })
})

describe('cleanOsaMessage', () => {
  it('strips positions, prefixes and error numbers', () => {
    expect(cleanOsaMessage('0:5: execution error: The variable retur is not defined. (-2753)\n')).toBe(
      'The variable retur is not defined.'
    )
    expect(cleanOsaMessage('execution error: Error: Error: Application can’t be found. (-2700)')).toBe(
      'Application can’t be found.'
    )
  })
})

describe('osaError', () => {
  it('maps -1743 to the Automation pane, naming the target app', () => {
    const err = osaError('12:40: execution error: Not authorized to send Apple events to Calendar. (-1743)')
    expect(err).toBeInstanceOf(MacError)
    expect(err.kind).toBe('automation')
    expect(err.code).toBe(-1743)
    expect(err.message).toBe('Allow fastASL to control Calendar in System Settings › Privacy & Security › Automation')
  })

  it('uses the app option when the message does not name one', () => {
    expect(osaError('Not authorized to send Apple events', 'Mail').message).toContain('control Mail in')
  })

  it('maps assistive-access and keystroke errors to the Accessibility pane', () => {
    const expected = 'Allow fastASL in System Settings › Privacy & Security › Accessibility'
    expect(osaError('execution error: System Events got an error: osascript is not allowed assistive access. (-1719)').message).toBe(expected)
    expect(osaError('System Events got an error: osascript is not allowed to send keystrokes. (1002)').kind).toBe('accessibility')
    expect(osaError('something (-25211)').kind).toBe('accessibility')
  })

  it('does not treat -1719 "Invalid index" as a permission problem', () => {
    const err = osaError(
      "execution error: System Events got an error: Can't get window 1 of application process 1 whose frontmost = true. Invalid index. (-1719)"
    )
    expect(err.kind).toBe('failed')
  })

  it('maps missing apps', () => {
    expect(osaError('execution error: Error: Error: Application can’t be found. (-2700)', 'Spotify').message).toBe(
      "Spotify isn't installed"
    )
    expect(osaError('execution error: Can’t get application "Foo". (-1728)').message).toBe("Foo isn't installed")
    expect(osaError("Unable to find application named 'Fooo'", 'Fooo').kind).toBe('not-installed')
  })

  it('maps not running, timeouts and cancel', () => {
    expect(osaError('execution error: Application isn’t running. (-600)', 'Spotify').message).toBe("Spotify isn't running")
    expect(osaError('execution error: Calendar got an error: AppleEvent timed out. (-1712)', 'Calendar').kind).toBe('timeout')
    expect(osaError('execution error: User canceled. (-128)').message).toBe('Cancelled')
  })

  it('does not read every JXA -2700 as a missing app', () => {
    const err = osaError('execution error: Error: Error: paste failed (-2700)', 'System Events')
    expect(err.kind).toBe('failed')
    expect(err.message).toBe('paste failed')
  })

  it('falls back to the cleaned message', () => {
    const err = osaError('execution error: There’s no calendar you can add events to. (9001)')
    expect(err.kind).toBe('failed')
    expect(err.message).toBe('There’s no calendar you can add events to.')
    expect(err.code).toBe(9001)
  })
})

describe.runIf(onMac)('runAppleScript / runJxa', () => {
  it('returns stdout without the trailing newline', async () => {
    expect(await runAppleScript('return "a" & linefeed & "b"')).toBe('a\nb')
    expect(await runJxa('[1, 2].join("-")')).toBe('1-2')
  })

  it('rejects with a typed MacError', async () => {
    const err = await runAppleScript('error "Nope." number 9005').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MacError)
    expect((err as MacError).message).toBe('Nope.')
    expect((err as MacError).code).toBe(9005)
  })

  it('kills slow scripts and reports a timeout', async () => {
    const err = await runAppleScript('delay 5', { timeoutMs: 300, app: 'Calendar' }).catch((e: unknown) => e)
    expect((err as MacError).kind).toBe('timeout')
    expect((err as MacError).message).toBe('Calendar took too long to respond')
  })
})

describe('retryWhenNotRunning', () => {
  const notRunning = (): MacError => new MacError("Calendar isn't running", 'not-running', -600)
  const deps = () => ({ openHidden: vi.fn(async () => {}), sleep: vi.fn(async () => {}) })

  it('launches the app hidden and retries when it is not running (seen right after Calendar was quit)', async () => {
    const d = deps()
    const run = vi.fn().mockRejectedValueOnce(notRunning()).mockRejectedValueOnce(notRunning()).mockResolvedValue('12')
    expect(await retryWhenNotRunning(run, { app: 'Calendar', launch: true }, d)).toBe('12')
    expect(d.openHidden).toHaveBeenCalledOnce()
    expect(d.openHidden).toHaveBeenCalledWith('Calendar')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('gives up after a few tries', async () => {
    const d = deps()
    const run = vi.fn().mockRejectedValue(notRunning())
    await expect(retryWhenNotRunning(run, { app: 'Calendar', launch: true }, d)).rejects.toThrow("Calendar isn't running")
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('never retries other errors, or without launch and an app name', async () => {
    const d = deps()
    const timeout = vi.fn().mockRejectedValue(new MacError('Calendar took too long to respond', 'timeout'))
    await expect(retryWhenNotRunning(timeout, { app: 'Calendar', launch: true }, d)).rejects.toThrow('too long')
    await expect(retryWhenNotRunning(vi.fn().mockRejectedValue(notRunning()), { app: 'Calendar' }, d)).rejects.toThrow()
    await expect(retryWhenNotRunning(vi.fn().mockRejectedValue(notRunning()), { launch: true }, d)).rejects.toThrow()
    expect(d.openHidden).not.toHaveBeenCalled()
    expect(timeout).toHaveBeenCalledOnce()
  })
})
