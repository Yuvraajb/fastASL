import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { jsString, runJxa } from './osascript'

/**
 * The claude CLI's path: Terminal's new shells may not have ~/.local/bin (the installer's spot)
 * on their PATH yet, so a known install location wins over the bare name.
 */
export function claudeCommandPath(exists: (path: string) => boolean = existsSync, home = homedir()): string {
  const known = [join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  return known.find((path) => exists(path)) ?? 'claude'
}

/** A word for sh/zsh: single-quoted, with any single quote closed, escaped and reopened. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Columns for n tiled windows: up to 3 in one row, then two rows (4: 2x2, 6: 3x2, 8: 4x2). */
export function gridColumns(count: number): number {
  return count <= 3 ? count : Math.ceil(count / 2)
}

/**
 * JXA that opens `count` Terminal windows running `command`, tiled in a grid over the main
 * screen's visible area (below the menu bar, above the Dock). Prints how many it opened.
 */
export function terminalScript(count: number, command: string): string {
  const cols = gridColumns(count)
  const rows = Math.ceil(count / cols)
  return `ObjC.import('AppKit')
const T = Application('Terminal')
T.activate()
const screen = $.NSScreen.mainScreen
const full = screen.frame
const vis = screen.visibleFrame
const top = full.size.height - (vis.origin.y + vis.size.height)
const W = vis.size.width / ${cols}
const H = vis.size.height / ${rows}
let opened = 0
for (let i = 0; i < ${count}; i++) {
  T.doScript(${jsString(command)})
  delay(0.2)
  const c = i % ${cols}
  const r = Math.floor(i / ${cols})
  T.windows[0].bounds = { x: Math.round(vis.origin.x + c * W), y: Math.round(top + r * H), width: Math.round(W), height: Math.round(H) }
  opened++
}
opened`
}

/** Opens `count` tiled Terminal windows, each running `command`. Returns how many opened. */
export async function openTerminals(count: number, command: string): Promise<number> {
  const out = await runJxa(terminalScript(count, command), { timeoutMs: 30_000, app: 'Terminal' })
  return Number(out) || count
}
