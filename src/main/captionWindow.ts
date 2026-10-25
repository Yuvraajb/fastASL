import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { CaptionState } from '@shared/types'

/**
 * The caption camera: a plain 1280x720 window with the camera and big live captions of what the
 * user signs. OBS captures it ("Window Capture" of "fastASL Captions") and publishes it as "OBS
 * Virtual Camera", which FaceTime can use as its camera: the person on the call sees the captions
 * burned into the video. fastASL never needs a camera extension of its own.
 */
export const CAPTION_TITLE = 'fastASL Captions'

let win: BrowserWindow | null = null
let last: CaptionState = { live: '', last: '', lastAt: 0 }

/** Relays the overlay's captions to the caption window (and keeps the latest for a window opened later). */
export function registerCaptions(): void {
  ipcMain.on(IPC.captionsUpdate, (_e, state: CaptionState) => {
    last = state
    if (win && !win.isDestroyed()) win.webContents.send(IPC.captionsState, state)
  })
}

/** Opens the caption window, or brings it forward if it is open. */
export function openCaptionWindow(load: (win: BrowserWindow, query: Record<string, string>) => void): void {
  if (win && !win.isDestroyed()) {
    win.show()
    return
  }
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    resizable: true,
    title: CAPTION_TITLE,
    backgroundColor: '#000000',
    show: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // OBS captures it while it sits behind other windows: keep it rendering.
      backgroundThrottling: false
    }
  })
  win.setAspectRatio(16 / 9)
  win.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.on('did-finish-load', () => win?.webContents.send(IPC.captionsState, last))
  win.on('closed', () => {
    win = null
  })
  load(win, { captions: '1' })
}
