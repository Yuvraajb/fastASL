import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { openApp } from '../mac/apps'
import { TOOLS, findTool, runTool } from './index'

vi.mock('electron', () => ({ app: {}, shell: { openExternal: vi.fn() } }))
vi.mock('../mac/apps', () => ({
  openApp: vi.fn(),
  takeScreenshot: vi.fn(),
  webSearch: vi.fn(),
  appPath: vi.fn()
}))

const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  get_frontmost_app: {},
  calendar_list_events: { range: 'today' },
  calendar_create_event: {
    title: 'Design review',
    start_iso: '2026-10-25T10:00:00',
    end_iso: '2026-10-25T11:00:00',
    attendees: ['a@example.com']
  },
  contacts_find: { query: 'Sarah' },
  mail_send: { to: 'a@example.com', subject: 'Hi', body: 'Hello' },
  mail_list: { limit: 5, unread_only: false },
  mail_read: { id: '1' },
  mail_reply: { id: '1', body: 'On my way' },
  message_send: { contact_name: 'Sarah Chen', text: 'On my way' },
  notes_search: { query: 'groceries' },
  notes_read: { title: 'Groceries' },
  spotify_search: { query: 'motion sickness' },
  spotify_play: { uri: 'spotify:track:5xo8RrjJ9CVNrtRg2S3B1R', name: 'Motion Sickness' },
  spotify_pause: {},
  media_control: { action: 'play' },
  facetime_call: { contact_name: 'Dad' },
  captions_on: {},
  captions_off: {},
  files_find: { query: 'resume' },
  files_list: { folder: 'Desktop' },
  files_move: { folder: 'Desktop', files: ['a.png'], destination: 'Screenshots' },
  set_volume: { level: 30 },
  set_dark_mode: { mode: 'on' },
  set_timer: { minutes: 5 },
  lock_screen: {},
  open_app: { name: 'Calendar' },
  web_search: { query: 'weather' },
  type_text: { text: 'hello' },
  take_screenshot: {}
}

describe('tool registry', () => {
  it('exposes every tool once', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(SAMPLE_ARGS).sort())
    expect(findTool('mail_send')?.name).toBe('mail_send')
    expect(findTool('rm_rf')).toBeUndefined()
  })

  it('asks for confirmation exactly for tools that send or create', () => {
    const write = TOOLS.filter((t) => t.risk === 'write').map((t) => t.name)
    expect(write.sort()).toEqual([
      'calendar_create_event',
      'files_move',
      'lock_screen',
      'mail_reply',
      'mail_send',
      'message_send'
    ])
  })

  it('gives every write tool a confirm card', () => {
    for (const tool of TOOLS.filter((t) => t.risk === 'write')) {
      const args = z.object(tool.schema).parse(SAMPLE_ARGS[tool.name])
      expect(tool.confirmDetails?.(args).kind, tool.name).toMatch(/event|mail|message|generic/)
    }
  })

  it('has short step labels and descriptions for every tool', () => {
    for (const tool of TOOLS) {
      const args = z.object(tool.schema).parse(SAMPLE_ARGS[tool.name])
      const label = tool.stepLabel(args)
      expect(label.length, tool.name).toBeGreaterThan(0)
      expect(label.length, tool.name).toBeLessThanOrEqual(40)
      expect(tool.description.length, tool.name).toBeGreaterThan(10)
    }
    expect(findTool('spotify_play')?.stepLabel(SAMPLE_ARGS.spotify_play)).toBe('Playing Motion Sickness')
    expect(findTool('open_app')?.stepLabel({ name: 'Calendar' })).toBe('Opening Calendar')
  })
})

describe('runTool', () => {
  beforeEach(() => {
    vi.mocked(openApp).mockReset()
  })

  it('rejects unknown tools', async () => {
    expect(await runTool('format_disk', {})).toEqual({ ok: false, text: 'Unknown tool: format_disk' })
  })

  it('validates arguments and names the bad field', async () => {
    const missing = await runTool('mail_send', { subject: 'Hi', body: 'x' })
    expect(missing.ok).toBe(false)
    expect(missing.text).toMatch(/^Invalid arguments for mail_send: to: Required/)

    const badEmail = await runTool('calendar_create_event', { ...SAMPLE_ARGS.calendar_create_event, attendees: ['Sarah'] })
    expect(badEmail.text).toContain('attendees.0: Invalid email')

    const badDate = await runTool('calendar_create_event', { ...SAMPLE_ARGS.calendar_create_event, start_iso: 'tomorrow 10am' })
    expect(badDate.text).toContain('start_iso: Use an ISO 8601 date-time')

    const badType = await runTool('open_app', { name: 42 })
    expect(badType.text).toContain('name: Expected string, received number')

    expect((await runTool('calendar_list_events', { range: 'month' })).ok).toBe(false)
    expect((await runTool('open_app', undefined)).text).toContain('name: Required')
  })

  it('runs a valid call with parsed (trimmed) arguments', async () => {
    vi.mocked(openApp).mockResolvedValue()
    expect(await runTool('open_app', { name: '  Calendar ' })).toEqual({
      ok: true,
      text: 'Opened Calendar.',
      title: 'Opened Calendar'
    })
    expect(openApp).toHaveBeenCalledWith('Calendar')
  })

  it('turns a thrown error into a failed outcome instead of rejecting', async () => {
    vi.mocked(openApp).mockRejectedValue(new Error("Fooapp isn't installed"))
    expect(await runTool('open_app', { name: 'Fooapp' })).toEqual({ ok: false, text: "Fooapp isn't installed" })
    expect(await findTool('open_app')?.run({ name: 'Fooapp' })).toEqual({ ok: false, text: "Fooapp isn't installed" })
  })

  it('reports a missing Spotify key as a failed outcome', async () => {
    const saved = process.env.SPOTIFY_CLIENT_ID
    delete process.env.SPOTIFY_CLIENT_ID
    try {
      expect(await runTool('spotify_search', { query: 'x' })).toEqual({ ok: false, text: 'Add SPOTIFY_CLIENT_ID to .env' })
    } finally {
      if (saved !== undefined) process.env.SPOTIFY_CLIENT_ID = saved
    }
  })

  it('rejects play requests that are not Spotify URIs before touching the app', async () => {
    const outcome = await runTool('spotify_play', { uri: 'Motion Sickness' })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('is not a Spotify URI')
  })
})
