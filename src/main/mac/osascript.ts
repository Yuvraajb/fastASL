import { execFile } from 'node:child_process'

export type MacErrorKind =
  | 'automation'
  | 'accessibility'
  | 'screen-recording'
  | 'not-installed'
  | 'not-running'
  | 'timeout'
  | 'cancelled'
  | 'failed'

/** A Mac automation failure whose `message` is safe to show on the card. */
export class MacError extends Error {
  constructor(
    message: string,
    readonly kind: MacErrorKind,
    readonly code?: number,
    readonly raw?: string
  ) {
    super(message)
    this.name = 'MacError'
  }
}

export interface OsaOptions {
  timeoutMs?: number
  /** App the script talks to; used to word errors ("Spotify isn't running"). */
  app?: string
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Field / record / list separators used by scripts that return structured text. */
export const SEP = { field: '\u001f', record: '\u001e', list: '\u001d' } as const

/** AppleScript statements that define US / RS / GS matching `SEP`. */
export const AS_SEPARATORS = 'set US to character id 31\nset RS to character id 30\nset GS to character id 29'

export function runAppleScript(script: string, options?: OsaOptions): Promise<string> {
  return osascript(['-e', script], options)
}

export function runJxa(script: string, options?: OsaOptions): Promise<string> {
  return osascript(['-l', 'JavaScript', '-e', script], options)
}

function osascript(args: string[], { timeoutMs = DEFAULT_TIMEOUT_MS, app }: OsaOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.replace(/\n$/, ''))
      if (err.killed) return reject(new MacError(`${app ?? 'The app'} took too long to respond`, 'timeout'))
      reject(osaError(stderr || err.message, app))
    })
  })
}

/**
 * Text literal for AppleScript source. Quotes, backslashes and common
 * whitespace are escaped; any other control character is spliced in with
 * `character id N`, so no input can end the literal early or inject code.
 */
export function appleScriptString(value: string): string {
  let out = ''
  let spliced = false
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\ufffd' // lone surrogate: not representable
    else if (cp < 0x20 || cp === 0x7f || cp === 0x2028 || cp === 0x2029) {
      out += `" & (character id ${cp}) & "`
      spliced = true
    } else out += ch
  }
  return spliced ? `("${out}")` : `"${out}"`
}

/** String literal for JXA (JavaScript) source. */
export function jsString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** Splits text produced with `SEP.record` / `SEP.field`. */
export function splitRecords(output: string): string[][] {
  return output ? output.split(SEP.record).map((record) => record.split(SEP.field)) : []
}

/** Removes osascript's position / "execution error:" prefixes and the trailing error number. */
export function cleanOsaMessage(raw: string): string {
  return raw
    .trim()
    .replace(/^\d+:\d+:\s*/, '')
    .replace(/^(execution|compilation|syntax) error:\s*/i, '')
    .replace(/^(Error:\s*)+/, '')
    .replace(/\s*\(-?\d+\)\s*$/, '')
    .trim()
}

const AUTOMATION_PANE = 'System Settings › Privacy & Security › Automation'
const ACCESSIBILITY_PANE = 'System Settings › Privacy & Security › Accessibility'

/** Maps raw osascript stderr to a MacError with a message a person can act on. */
export function osaError(raw: string, app?: string): MacError {
  const code = Number(/\((-?\d+)\)\s*$/.exec(raw.trim())?.[1] ?? NaN)
  const message = cleanOsaMessage(raw)
  const appName = /application "([^"]+)"/i.exec(message)?.[1] ?? app

  if (code === -1743 || /not authori[sz]ed to send apple events/i.test(message)) {
    const target = /apple events to ([^.]+)/i.exec(message)?.[1]?.trim() ?? app ?? 'that app'
    return new MacError(`Allow fastASL to control ${target} in ${AUTOMATION_PANE}`, 'automation', code, raw)
  }
  // -1719 is also "Invalid index" (e.g. an app with no windows), which is not a permission problem.
  if (
    code === -25211 ||
    (code === -1719 && !/invalid index/i.test(message)) ||
    /assistive access|not allowed to send keystrokes/i.test(message)
  ) {
    return new MacError(`Allow fastASL in ${ACCESSIBILITY_PANE}`, 'accessibility', code, raw)
  }
  // -2700 is JXA's code for any uncaught error, so only its message identifies a missing app.
  if (
    code === -10814 ||
    /application can.t be found|unable to find application/i.test(message) ||
    (code === -1728 && /can.t get application/i.test(message))
  ) {
    return new MacError(`${appName ?? 'That app'} isn't installed`, 'not-installed', code, raw)
  }
  if (code === -600 || code === -609 || /application isn.t running/i.test(message)) {
    return new MacError(`${appName ?? 'The app'} isn't running`, 'not-running', code, raw)
  }
  if (code === -1712) return new MacError(`${appName ?? 'The app'} took too long to respond`, 'timeout', code, raw)
  if (code === -128) return new MacError('Cancelled', 'cancelled', code, raw)
  return new MacError(message || 'The automation script failed', 'failed', Number.isNaN(code) ? undefined : code, raw)
}
