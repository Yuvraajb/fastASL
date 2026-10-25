import { nativeImage } from 'electron'
import type { Result } from '@shared/types'
import { tookScreenshot } from './tools/screenshots'

/** Thumbnail width in px: the card shows it at about half that, sharp on Retina. */
export const THUMB_WIDTH = 320

/** The slice of Electron's NativeImage a thumbnail needs (tests pass a fake). */
export interface ThumbSource {
  isEmpty(): boolean
  resize(options: { width: number }): { toDataURL(): string }
}

export type ImageLoader = (path: string) => ThumbSource

const fromFile: ImageLoader = (path) => nativeImage.createFromPath(path)

/**
 * A small PNG data URL of a screenshot fastASL took this session (take_screenshot remembers
 * each one). Any other path is refused before the file is opened, so the renderer can't read
 * images from elsewhere on disk through this call.
 */
export function imageThumb(path: unknown, load: ImageLoader = fromFile): Result<string> {
  if (!tookScreenshot(path)) return { ok: false, error: 'Not a screenshot fastASL took' }
  try {
    const image = load(path)
    if (image.isEmpty()) return { ok: false, error: "Couldn't read the screenshot" }
    return { ok: true, value: image.resize({ width: THUMB_WIDTH }).toDataURL() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
