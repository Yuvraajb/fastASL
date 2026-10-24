import { app, BrowserWindow, ipcMain, session, systemPreferences } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import type { AgentEvent, Result } from '@shared/types'
import { loadEnv } from './env'
import { registerIpc, type MainServices } from './ipc'
import { getSettings } from './store'
import { createOverlayWindow, createStageWindow, type OverlayWindow } from './window'
import { registerDevShortcuts, setupTray } from './devtools'
import { startMjpegProxy, type MjpegProxy } from './camera/mjpegProxy'
import { createClaudeService } from './claude'
import { createAgentServices } from './agent'
import { TOOLS } from './tools'
import { getFrontmostApp } from './mac/frontmost'

const screenshots = process.env.FASTASL_SCREENSHOTS === '1'
const dev = !app.isPackaged || process.env.FASTASL_DEV === '1'
/** FASTASL_LOG=1 prints the renderer's console to stdout (smoke tests, debugging). */
const logRenderer = process.env.FASTASL_LOG === '1'
/** FASTASL_MOCK=1 runs the overlay on mock services (Claude, agent, typing); the camera stays live. */
const mockServices = process.env.FASTASL_MOCK === '1'

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

/** Dev: one terminal line per Claude call (request -> answer), to check the card's routing against it. */
function devLogged<Req, T>(name: string, call: (req: Req) => Promise<Result<T>>): (req: Req) => Promise<Result<T>> {
  if (!dev) return call
  return async (req) => {
    const res = await call(req)
    console.log(`[claude] ${name} ${JSON.stringify(req)} -> ${JSON.stringify(res.ok ? res.value : { error: res.error })}`)
    return res
  }
}

/** Dev: one terminal line per agent event, next to the [agent] session logs. */
function devLoggedEmit(emit: (e: AgentEvent) => void): (e: AgentEvent) => void {
  if (!dev) return emit
  return (e) => {
    console.log(`[agent] ${JSON.stringify(e)}`)
    emit(e)
  }
}

// Claude phrases intents in terms of the agent's real tools.
const claude = createClaudeService({ tools: () => TOOLS.map(({ name, description }) => ({ name, description })) })

const services: MainServices = {
  interpret: devLogged('interpret', claude.interpret),
  spellSuggest: devLogged('spellSuggest', claude.spellSuggest),
  frontmostApp: getFrontmostApp,
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

/** Longest wait on quit for the droid process to exit before the app goes anyway. */
const AGENT_DISPOSE_MS = 3000

/**
 * The Factory Droid agent: one persistent session, opened in the background now so the first
 * command doesn't wait for it. A missing key or droid CLI is reported when a command is sent.
 */
function startAgent(): void {
  const agent = createAgentServices()
  services.agentRun = (req, emit) => agent.agentRun(req, devLoggedEmit(emit))
  services.agentStop = agent.agentStop
  services.agentRespond = agent.agentRespond
  services.runShortcut = (gestureId, emit) => agent.runShortcut(gestureId, devLoggedEmit(emit))

  // Hold the quit until the droid process is closed (bounded), so it never outlives the app.
  let disposed = false
  app.on('before-quit', (e) => {
    if (disposed) return
    disposed = true
    e.preventDefault()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, AGENT_DISPOSE_MS))
    void Promise.race([agent.dispose().catch(() => undefined), timeout]).then(() => app.quit())
  })
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

  // The renderer uses mock services then, so no droid process is started.
  if (!mockServices) startAgent()
  await startCameraProxy()

  if (process.platform === 'darwin') {
    app.dock?.hide()
    // Only prompt when the built-in camera will actually be used (not for an ESP32 stream).
    const { cameraEnabled, cameraSource } = getSettings()
    if (cameraEnabled && cameraSource.kind === 'builtin' && systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      void systemPreferences.askForMediaAccess('camera')
    }
  }

  overlay = createOverlayWindow({ dev, screenshots, mockServices })
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
