import { BrowserWindow, Menu, Tray, app, globalShortcut, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc'
import type { DevCommand, SimGesture } from '@shared/types'

/** Views reachable from the dev menu. Ids must match renderer/src/app/mocks.ts. */
export const DEV_VIEWS: { id: string; label: string }[] = [
  { id: 'ready', label: '1 Ready' },
  { id: 'recognizing', label: '2 Recognizing' },
  { id: 'building', label: '3 Building' },
  { id: 'sentence', label: '4 Sentence' },
  { id: 'agentReady', label: '5 Agent ready' },
  { id: 'working', label: '6 Working' },
  { id: 'confirm', label: '7 Confirm' },
  { id: 'done', label: '8 Done' },
  { id: 'collapsed', label: '9 Collapsed' },
  { id: 'listening', label: 'Listening' },
  { id: 'buildingWords', label: 'Building (words)' },
  { id: 'agentReadyEmail', label: 'Agent ready (email)' },
  { id: 'confirmMessage', label: 'Confirm (message)' },
  { id: 'didYouMean', label: 'Did you mean (list)' },
  { id: 'didYouMeanQuote', label: 'Did you mean (yes/edit)' },
  { id: 'contextActions', label: 'Context actions' },
  { id: 'quickMenu', label: 'Quick menu' },
  { id: 'dictation', label: 'Dictation' },
  { id: 'toast', label: 'Gesture toast' },
  { id: 'settings', label: 'Settings' },
  { id: 'settingsTeach', label: 'Settings: teach a sign' },
  { id: 'settingsTeachRecord', label: 'Settings: recording' },
  { id: 'settingsNewGesture', label: 'Settings: new gesture' },
  { id: 'settingsHoldShape', label: 'Settings: hold shape' },
  { id: 'settingsGestures', label: 'Settings: my gestures' },
  { id: 'settingsCamera', label: 'Settings: camera source' },
  { id: 'settingsSensitivity', label: 'Settings: sensitivity' },
  { id: 'missingKey', label: 'Missing key notice' },
  { id: 'palmHold', label: 'Collapsed + palm hold' }
]

const GESTURES: { gesture: SimGesture; label: string; accelerator: string }[] = [
  { gesture: 'palmHold', label: 'Open palm hold (expand)', accelerator: 'Control+Alt+P' },
  { gesture: 'thumbsUp', label: 'Thumbs up', accelerator: 'Control+Alt+T' },
  { gesture: 'fist', label: 'Fist', accelerator: 'Control+Alt+F' },
  { gesture: 'swipeLeft', label: 'Swipe left', accelerator: 'Control+Alt+Left' },
  { gesture: 'swipeRight', label: 'Swipe right', accelerator: 'Control+Alt+Right' },
  { gesture: 'swipeUp', label: 'Swipe up', accelerator: 'Control+Alt+Up' },
  { gesture: 'fingers1', label: '1 finger', accelerator: 'Control+Alt+1' },
  { gesture: 'fingers2', label: '2 fingers', accelerator: 'Control+Alt+2' },
  { gesture: 'fingers3', label: '3 fingers', accelerator: 'Control+Alt+3' },
  { gesture: 'fingers4', label: '4 fingers', accelerator: 'Control+Alt+4' },
  { gesture: 'fingers5', label: '5 fingers', accelerator: 'Control+Alt+5' },
  { gesture: 'handsDown', label: 'Both hands down (end phrase)', accelerator: 'Control+Alt+H' },
  { gesture: 'signToken', label: 'Simulate a recognized sign', accelerator: 'Control+Alt+S' },
  { gesture: 'peace', label: 'Peace sign shortcut', accelerator: 'Control+Alt+V' }
]

function send(cmd: DevCommand): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.devCommand, cmd)
  }
}

let tray: Tray | null = null

export function setupTray(opts: { dev: boolean; onToggle: () => void }): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('ASL')
  tray.setToolTip('fastASL')
  const template: MenuItemConstructorOptions[] = [{ label: 'Show / hide fastASL', click: opts.onToggle }]
  if (opts.dev) {
    template.push(
      { type: 'separator' },
      {
        label: 'Dev: states',
        submenu: DEV_VIEWS.map((v) => ({ label: v.label, click: () => send({ type: 'setView', id: v.id }) }))
      },
      {
        label: 'Dev: simulate gesture',
        submenu: GESTURES.map((g) => ({
          label: g.label,
          accelerator: g.accelerator,
          click: () => send({ type: 'gesture', gesture: g.gesture })
        }))
      },
      { label: 'Dev: toggle dev panel', accelerator: 'Alt+0', click: () => send({ type: 'toggleDevPanel' }) }
    )
  }
  template.push({ type: 'separator' }, { label: 'Quit fastASL', click: () => app.quit() })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

/** Dev-only global hotkeys: Option+1..9 jump to states, Control+Option+<key> simulates gestures. */
export function registerDevShortcuts(): void {
  const first9 = DEV_VIEWS.slice(0, 9)
  first9.forEach((v, i) => {
    globalShortcut.register(`Alt+${i + 1}`, () => send({ type: 'setView', id: v.id }))
  })
  globalShortcut.register('Alt+0', () => send({ type: 'toggleDevPanel' }))
  for (const g of GESTURES) {
    globalShortcut.register(g.accelerator, () => send({ type: 'gesture', gesture: g.gesture }))
  }
  app.on('will-quit', () => globalShortcut.unregisterAll())
}
