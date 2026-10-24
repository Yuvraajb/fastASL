import { app, BrowserWindow, ipcMain, session, systemPreferences } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import { loadEnv } from './env'
import { registerIpc, type MainServices } from './ipc'
import { createOverlayWindow, createStageWindow, type OverlayWindow } from './window'
import { registerDevShortcuts, setupTray } from './devtools'

const screenshots = process.env.FASTASL_SCREENSHOTS === '1'
const dev = !app.isPackaged || process.env.FASTASL_DEV === '1'

app.setName('fastASL')
loadEnv()

let overlay: OverlayWindow | null = null
let stage: BrowserWindow | null = null

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

  if (process.platform === 'darwin') {
    app.dock?.hide()
    if (systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      void systemPreferences.askForMediaAccess('camera')
    }
  }

  overlay = createOverlayWindow({ dev, screenshots })
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
