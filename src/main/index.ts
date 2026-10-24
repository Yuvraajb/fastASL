import { app, BrowserWindow, ipcMain, session, systemPreferences } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import { loadEnv } from './env'
import { registerIpc, type MainServices } from './ipc'
import { getSettings } from './store'
import { createOverlayWindow, createStageWindow, type OverlayWindow } from './window'
import { registerDevShortcuts, setupTray } from './devtools'
import { startMjpegProxy, type MjpegProxy } from './camera/mjpegProxy'

const screenshots = process.env.FASTASL_SCREENSHOTS === '1'
const dev = !app.isPackaged || process.env.FASTASL_DEV === '1'
/** FASTASL_LOG=1 prints the renderer's console to stdout (smoke tests, debugging). */
const logRenderer = process.env.FASTASL_LOG === '1'

app.setName('fastASL')
loadEnv()

let overlay: OverlayWindow | null = null
let stage: BrowserWindow | null = null
let mjpegProxy: MjpegProxy | null = null

function loadRenderer(win: BrowserWindow, query: Record<string, string> = {}): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(devUrl)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

const services: MainServices = {
  capture: async (name: string) => {
    if (!stage) return ''
    const dir = join(process.cwd(), 'docs', 'screens')
    mkdirSync(dir, { recursive: true })
    const image = await stage.webContents.capturePage()
    const file = join(dir, `${name}.png`)
    writeFileSync(file, image.toPNG())
    return file
  }
}

function forwardConsole(win: BrowserWindow): void {
  win.webContents.on('console-message', ({ level, message }) => console.log(`[renderer:${level}] ${message}`))
}

/** ESP32-CAM streams go through a local CORS proxy so MediaPipe can read the frames. */
async function startCameraProxy(): Promise<void> {
  try {
    const proxy = await startMjpegProxy()
    mjpegProxy = proxy
    services.mjpegProxyUrl = async (url) => proxy.urlFor(url)
  } catch (err) {
    // Without the proxy only MJPEG sources fail ("Can't reach the ESP32 stream").
    console.error('[camera] MJPEG proxy failed to start', err)
  }
}

async function boot(): Promise<void> {
  // Camera / mic permission for the renderer (getUserMedia). Audio is never used.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      callback(types.every((t) => t === 'video'))
      return
    }
    callback(permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  registerIpc(() => overlay, services)
  ipcMain.on(IPC.quit, () => app.quit())

  if (screenshots) {
    stage = createStageWindow()
    loadRenderer(stage, { stage: '1', only: process.env.FASTASL_SCREENS_ONLY ?? '' })
    return
  }

  await startCameraProxy()

  if (process.platform === 'darwin') {
    app.dock?.hide()
    // Only prompt when the built-in camera will actually be used (not for an ESP32 stream).
    const { cameraEnabled, cameraSource } = getSettings()
    if (cameraEnabled && cameraSource.kind === 'builtin' && systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      void systemPreferences.askForMediaAccess('camera')
    }
  }

  overlay = createOverlayWindow({ dev, screenshots })
  if (logRenderer) forwardConsole(overlay.win)
  loadRenderer(overlay.win)

  setupTray({
    dev,
    onToggle: () => {
      if (!overlay) return
      if (overlay.win.isVisible()) overlay.win.hide()
      else overlay.win.showInactive()
    }
  })
  if (dev) registerDevShortcuts()
}

app.whenReady().then(boot)

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => void mjpegProxy?.close())
