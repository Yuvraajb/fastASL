import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import { exec } from './exec'
import { MacError, jsString, osaError, runJxa } from './osascript'

/** Launches or focuses an app by name (`open -a`). */
export async function openApp(name: string): Promise<void> {
  try {
    await exec('open', ['-a', name])
  } catch (err) {
    throw osaError((err as Error).message, name)
  }
}

/** Absolute path of an installed app, or null. Uses LaunchServices, so it never prompts. */
export async function appPath(bundleId: string): Promise<string | null> {
  const path = await runJxa(
    `ObjC.import('AppKit');
const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(${jsString(bundleId)});
url.isNil() ? '' : url.path.js;`,
    { timeoutMs: 5000 }
  )
  return path || null
}

export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`
}

/** Opens a Google search in the default browser and returns the URL. */
export async function webSearch(query: string): Promise<string> {
  const url = googleSearchUrl(query)
  await shell.openExternal(url)
  return url
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "fastASL Screenshot 2026-10-24 at 14.03.22.png", matching macOS's own naming. */
export function screenshotFileName(at: Date, copy = 1): string {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`
  return `fastASL Screenshot ${day} at ${time}${copy > 1 ? ` (${copy})` : ''}.png`
}

const SCREEN_RECORDING = 'Allow fastASL in System Settings › Privacy & Security › Screen & System Audio Recording'

/** Silent full-screen capture to the Desktop. Resolves with the file path once the file is verified. */
export async function takeScreenshot(at = new Date(), dir = join(homedir(), 'Desktop')): Promise<string> {
  let copy = 1
  while (existsSync(join(dir, screenshotFileName(at, copy)))) copy++
  const path = join(dir, screenshotFileName(at, copy))

  try {
    await exec('screencapture', ['-x', path], 15_000)
  } catch (err) {
    throw new MacError(SCREEN_RECORDING, 'screen-recording', undefined, (err as Error).message)
  }
  if (!existsSync(path) || statSync(path).size === 0) throw new MacError(SCREEN_RECORDING, 'screen-recording')
  return path
}
