import { basename } from 'node:path'
import { z } from 'zod'
import { openApp, takeScreenshot, webSearch } from '../mac/apps'
import { getFrontmostApp } from '../mac/frontmost'
import { typeText } from '../mac/typeText'
import { plural, truncate } from './format'
import { fail } from './outcome'
import { rememberScreenshot } from './screenshots'
import { defineTool } from './types'

export const getFrontmostAppTool = defineTool({
  name: 'get_frontmost_app',
  description: 'Which app (and window, when allowed) the user is working in right now.',
  schema: {},
  risk: 'read',
  stepLabel: () => 'Checking the front app',
  async run() {
    const app = await getFrontmostApp()
    if (!app) return fail("Couldn't tell which app is in front")
    const window = app.windowTitle ? `, window "${app.windowTitle}"` : ''
    return { ok: true, text: `${app.name}${app.bundleId ? ` (${app.bundleId})` : ''}${window}` }
  }
})

export const openAppTool = defineTool({
  name: 'open_app',
  description:
    'Open (or bring to the front) a Mac app by name, e.g. "Calendar" or "Safari". Only for "open <app>": every other tool starts the app it needs by itself.',
  schema: { name: z.string().trim().min(1) },
  risk: 'read',
  stepLabel: (args) => truncate(`Opening ${args.name}`, 40),
  async run(args) {
    await openApp(args.name)
    return { ok: true, text: `Opened ${args.name}.`, title: `Opened ${args.name}` }
  }
})

export const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Open a Google search for the query in the default browser.',
  schema: { query: z.string().trim().min(1) },
  risk: 'read',
  stepLabel: () => 'Searching the web',
  async run(args) {
    const url = await webSearch(args.query)
    return {
      ok: true,
      text: `Opened a Google search for "${args.query}" in the browser.`,
      title: 'Searched the web',
      subtitle: truncate(args.query, 60),
      view: { kind: 'openUrl', url }
    }
  }
})

export const typeTextTool = defineTool({
  name: 'type_text',
  description: 'Type text into the app the user is focused on (pasted; their clipboard is restored afterwards).',
  schema: { text: z.string().min(1) },
  risk: 'read',
  stepLabel: () => 'Typing text',
  async run(args) {
    const app = await getFrontmostApp()
    const result = await typeText(args.text)
    if (!result.ok) return fail(result.error)
    const into = app ? ` into ${app.name}` : ''
    return {
      ok: true,
      text: `Typed ${plural([...args.text].length, 'character')}${into}.`,
      title: 'Typed text',
      subtitle: app ? `into ${app.name}` : truncate(args.text, 60)
    }
  }
})

export const takeScreenshotTool = defineTool({
  name: 'take_screenshot',
  description: 'Take a full-screen screenshot and save it to the Desktop.',
  schema: {},
  risk: 'read',
  stepLabel: () => 'Taking screenshot',
  async run() {
    const path = await takeScreenshot()
    // The card may show a thumbnail of this file, and of no other (main's imageThumb).
    rememberScreenshot(path)
    return {
      ok: true,
      text: `Saved a screenshot to ${path}.`,
      title: 'Screenshot taken',
      subtitle: `Desktop · ${basename(path)}`,
      view: { kind: 'openFile', path }
    }
  }
})
