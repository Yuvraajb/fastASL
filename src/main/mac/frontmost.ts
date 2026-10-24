import type { FrontmostApp } from '@shared/types'
import { runAppleScript, runJxa } from './osascript'

const CACHE_MS = 300

/** NSWorkspace answers without any permission prompt. */
export const FRONT_APP_SCRIPT = `ObjC.import('AppKit');
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
app.isNil() ? '' : JSON.stringify({ name: app.localizedName.js, bundleId: app.bundleIdentifier.js });`

/** Needs Accessibility; fails (and is skipped) without it. */
export const FRONT_WINDOW_SCRIPT =
  'tell application "System Events" to tell (first application process whose frontmost is true) to return name of front window'

export function parseFrontmost(appJson: string, windowTitle?: string): FrontmostApp | null {
  try {
    const parsed = JSON.parse(appJson) as { name?: unknown; bundleId?: unknown }
    if (typeof parsed.name !== 'string' || !parsed.name) return null
    const app: FrontmostApp = { name: parsed.name }
    if (typeof parsed.bundleId === 'string' && parsed.bundleId) app.bundleId = parsed.bundleId
    const title = windowTitle?.trim()
    if (title && title !== 'missing value') app.windowTitle = title
    return app
  } catch {
    return null
  }
}

async function lookup(): Promise<FrontmostApp | null> {
  // Run both at once: the window title can stall on a permission prompt.
  const [app, title] = await Promise.allSettled([
    runJxa(FRONT_APP_SCRIPT, { timeoutMs: 3000 }),
    runAppleScript(FRONT_WINDOW_SCRIPT, { timeoutMs: 1500, app: 'System Events' })
  ])
  if (app.status === 'rejected') return null
  return parseFrontmost(app.value, title.status === 'fulfilled' ? title.value : undefined)
}

let cached: { at: number; value: FrontmostApp | null } | null = null
let inflight: Promise<FrontmostApp | null> | null = null

/** The app the user is working in. Cached for ~300ms; concurrent callers share one lookup. */
export function getFrontmostApp(): Promise<FrontmostApp | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value)
  inflight ??= lookup()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
