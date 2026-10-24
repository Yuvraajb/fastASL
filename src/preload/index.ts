import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type FastAslApi } from '@shared/ipc'
import type { AgentEvent, DevCommand } from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: FastAslApi = {
  isDev: process.argv.includes('--fastasl-dev'),
  isScreenshotMode: process.argv.includes('--fastasl-screenshots'),
  nativeVibrancy: process.argv.includes('--fastasl-vibrancy'),

  setCardSize: (size) => ipcRenderer.send(IPC.setCardSize, size),
  setFocusable: (focusable) => ipcRenderer.send(IPC.setFocusable, focusable),

  getEnvStatus: () => ipcRenderer.invoke(IPC.envStatus),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.saveSettings, patch),
  getTemplates: () => ipcRenderer.invoke(IPC.getTemplates),
  saveTemplates: (store) => ipcRenderer.invoke(IPC.saveTemplates, store),
  importPack: (pack) => ipcRenderer.invoke(IPC.importPack, pack),
  exportPack: () => ipcRenderer.invoke(IPC.exportPack),
  getGestures: () => ipcRenderer.invoke(IPC.getGestures),
  saveGestures: (gestures) => ipcRenderer.invoke(IPC.saveGestures, gestures),
  getRecentTasks: () => ipcRenderer.invoke(IPC.getRecentTasks),

  getMjpegProxyUrl: (url) => ipcRenderer.invoke(IPC.mjpegProxyUrl, url),
  getAssetBase: () => ipcRenderer.invoke(IPC.assetBase),

  interpret: (req) => ipcRenderer.invoke(IPC.interpret, req),
  spellSuggest: (req) => ipcRenderer.invoke(IPC.spellSuggest, req),

  agentRun: (req) => ipcRenderer.invoke(IPC.agentRun, req),
  agentStop: () => ipcRenderer.invoke(IPC.agentStop),
  agentRespond: (requestId, approved) => ipcRenderer.invoke(IPC.agentRespond, requestId, approved),
  onAgentEvent: (cb) => subscribe<AgentEvent>(IPC.agentEvent, cb),
  runShortcut: (gestureId) => ipcRenderer.invoke(IPC.runShortcut, gestureId),

  getFrontmostApp: () => ipcRenderer.invoke(IPC.frontmostApp),
  typeText: (text) => ipcRenderer.invoke(IPC.typeText, text),
  openTarget: (action) => ipcRenderer.invoke(IPC.openTarget, action),

  onDevCommand: (cb) => subscribe<DevCommand>(IPC.devCommand, cb),
  capture: (name) => ipcRenderer.invoke(IPC.capture, name),
  quit: () => ipcRenderer.send(IPC.quit)
}

contextBridge.exposeInMainWorld('fastasl', api)
