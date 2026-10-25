import { z } from 'zod'
import { exec } from '../mac/exec'
import { appleScriptString as q, runAppleScript } from '../mac/osascript'
import { plural, truncate } from './format'
import { fail } from './outcome'
import { defineTool } from './types'

export const setVolume = defineTool({
  name: 'set_volume',
  description: 'Set the Mac output volume to a level from 0 (silent) to 100. Use 0 to mute.',
  schema: { level: z.number().int().min(0).max(100) },
  risk: 'read',
  stepLabel: (args) => `Setting volume to ${args.level}`,
  async run(args) {
    await runAppleScript(`set volume output volume ${args.level}`)
    return {
      ok: true,
      text: `Volume set to ${args.level}.`,
      title: args.level === 0 ? 'Muted' : `Volume ${args.level}`
    }
  }
})

/** The System Events line that sets the appearance, for each mode. */
export function darkModeScript(mode: 'on' | 'off' | 'toggle'): string {
  const value = mode === 'on' ? 'true' : mode === 'off' ? 'false' : 'not dark mode'
  return `tell application "System Events" to tell appearance preferences to set dark mode to ${value}`
}

export const setDarkMode = defineTool({
  name: 'set_dark_mode',
  description: 'Switch the Mac between dark and light appearance: on = dark, off = light, or toggle.',
  schema: { mode: z.enum(['on', 'off', 'toggle']) },
  risk: 'read',
  stepLabel: () => 'Switching appearance',
  async run(args) {
    await runAppleScript(darkModeScript(args.mode), { app: 'System Events' })
    const now = await runAppleScript('tell application "System Events" to tell appearance preferences to return dark mode as text', {
      app: 'System Events'
    })
    const dark = now === 'true'
    return { ok: true, text: `The Mac is now in ${dark ? 'dark' : 'light'} mode.`, title: dark ? 'Dark mode on' : 'Light mode on' }
  }
})

const MAX_TIMER_MINUTES = 180
/** Running timers, so a second "timer" does not hide the first. */
const timers = new Set<NodeJS.Timeout>()

/** The notification script a timer shows when it ends. */
export function timerScript(label: string): string {
  return `display notification ${q(label)} with title "fastASL timer" sound name "Glass"`
}

export const setTimer = defineTool({
  name: 'set_timer',
  description: `Start a timer of 1 to ${MAX_TIMER_MINUTES} minutes; a notification with a sound shows when it ends.`,
  schema: {
    minutes: z.number().min(0.1).max(MAX_TIMER_MINUTES),
    label: z.string().trim().optional().describe('What the timer is for, shown when it ends')
  },
  risk: 'read',
  stepLabel: () => 'Starting a timer',
  async run(args) {
    const label = args.label ? truncate(args.label, 60) : 'Time is up'
    const text = args.minutes < 1 ? `${Math.round(args.minutes * 60)} seconds` : plural(Math.round(args.minutes * 10) / 10, 'minute')
    const handle = setTimeout(() => {
      timers.delete(handle)
      void runAppleScript(timerScript(label)).catch(() => undefined)
    }, args.minutes * 60_000)
    handle.unref?.()
    timers.add(handle)
    return { ok: true, text: `Timer set for ${text}.`, title: `Timer: ${text}`, subtitle: args.label ? truncate(args.label, 60) : undefined }
  }
})

export const lockScreen = defineTool({
  name: 'lock_screen',
  description: 'Turn off the display, which locks the Mac when it asks for a password right away. The user confirms first.',
  schema: {},
  risk: 'write',
  stepLabel: () => 'Locking the screen',
  confirmDetails: () => ({ kind: 'generic', title: 'Lock the screen', lines: ['The display turns off'] }),
  async run() {
    try {
      await exec('pmset', ['displaysleepnow'], 5000)
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Couldn't turn off the display")
    }
    return { ok: true, text: 'The display was turned off.', title: 'Screen locked' }
  }
})
