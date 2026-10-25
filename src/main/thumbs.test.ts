import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ createFromPath: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: { createFromPath: electron.createFromPath } }))

const apps = vi.hoisted(() => ({ takeScreenshot: vi.fn() }))
vi.mock('./mac/apps', () => ({ takeScreenshot: apps.takeScreenshot, openApp: vi.fn(), webSearch: vi.fn() }))

import { imageThumb, THUMB_WIDTH, type ImageLoader } from './thumbs'
import { forgetScreenshots, rememberScreenshot, tookScreenshot } from './tools/screenshots'
import { takeScreenshotTool } from './tools/system'

const SHOT = '/Users/me/Desktop/fastASL Screenshot 2026-10-24 at 15.45.12.png'

/** A loader that records what it opened and how it resized it. */
function fakeImages(empty = false) {
  const opened: string[] = []
  const widths: number[] = []
  const load: ImageLoader = (path) => {
    opened.push(path)
    return {
      isEmpty: () => empty,
      resize: ({ width }) => {
        widths.push(width)
        return { toDataURL: () => 'data:image/png;base64,THUMB' }
      }
    }
  }
  return { load, opened, widths }
}

beforeEach(() => {
  forgetScreenshots()
  vi.clearAllMocks()
})

describe('screenshot thumbnails', () => {
  it('serves a small PNG data URL of a screenshot take_screenshot wrote', async () => {
    apps.takeScreenshot.mockResolvedValue(SHOT)
    const outcome = await takeScreenshotTool.run({})
    expect(outcome).toMatchObject({ ok: true, title: 'Screenshot taken', view: { kind: 'openFile', path: SHOT } })
    const images = fakeImages()
    expect(imageThumb(SHOT, images.load)).toEqual({ ok: true, value: 'data:image/png;base64,THUMB' })
    expect(images.opened).toEqual([SHOT])
    expect(images.widths).toEqual([THUMB_WIDTH])
  })

  it('refuses any other file without opening it: other images, other paths, other types', () => {
    rememberScreenshot(SHOT)
    const images = fakeImages()
    const refused = [
      '/Users/me/Desktop/fastASL Screenshot 2026-10-24 at 15.45.13.png',
      '/Users/me/Documents/passport.png',
      '/etc/passwd',
      '',
      `${SHOT}/..`,
      undefined,
      null,
      42,
      { path: SHOT },
      [SHOT]
    ]
    for (const path of refused) expect(imageThumb(path, images.load)).toEqual({ ok: false, error: 'Not a screenshot fastASL took' })
    expect(images.opened).toEqual([])
  })

  it('normalizes the path, so `..` can neither reach past a screenshot nor hide one', () => {
    rememberScreenshot(SHOT)
    expect(tookScreenshot('/Users/me/Desktop/../Desktop/fastASL Screenshot 2026-10-24 at 15.45.12.png')).toBe(true)
    expect(tookScreenshot('/Users/me/Desktop/../Documents/fastASL Screenshot 2026-10-24 at 15.45.12.png')).toBe(false)
  })

  it('uses the real nativeImage by default, and says so when the file is gone or unreadable', () => {
    rememberScreenshot(SHOT)
    electron.createFromPath.mockReturnValue({ isEmpty: () => true })
    expect(imageThumb(SHOT)).toEqual({ ok: false, error: "Couldn't read the screenshot" })
    expect(electron.createFromPath).toHaveBeenCalledWith(SHOT)
    electron.createFromPath.mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(imageThumb(SHOT)).toEqual({ ok: false, error: 'EACCES' })
  })

  it('remembers the last 50 screenshots', () => {
    for (let i = 0; i < 51; i++) rememberScreenshot(`/Users/me/Desktop/shot ${i}.png`)
    expect(tookScreenshot('/Users/me/Desktop/shot 0.png')).toBe(false)
    expect(tookScreenshot('/Users/me/Desktop/shot 1.png')).toBe(true)
    expect(tookScreenshot('/Users/me/Desktop/shot 50.png')).toBe(true)
  })

  it('a failed screenshot is not remembered', async () => {
    apps.takeScreenshot.mockRejectedValue(new Error('Allow fastASL in System Settings'))
    await expect(takeScreenshotTool.run({})).rejects.toThrow('Allow fastASL')
    expect(tookScreenshot(SHOT)).toBe(false)
  })
})
