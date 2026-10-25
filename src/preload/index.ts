import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type FastAslApi } from '@shared/ipc'
import type { AgentEvent, CaptionState, DevCommand, LlmStatusEvent } from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** A `--name=<URI-encoded value>` argument main passed to this window, or ''. */
function argValue(name: string): string {
  const prefix = `--${name}=`
  const arg = process.argv.find((a) => a.startsWith(prefix))
  if (!arg) return ''
  try {
    return decodeURIComponent(arg.slice(prefix.length))
  } catch {
    return arg.slice(prefix.length)
  }
}

const api: FastAslApi = {
  isDev: process.argv.includes('--fastasl-dev'),
  isScreenshotMode: process.argv.includes('--fastasl-screenshots'),
  nativeVibrancy: process.argv.includes('--fastasl-vibrancy'),
  mockServices: process.argv.includes('--fastasl-mock'),
  llmProvider: argValue('fastasl-llm'),

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

  interpret: (req, callId) => ipcRenderer.invoke(IPC.interpret, req, callId),
  spellSuggest: (req, callId) => ipcRenderer.invoke(IPC.spellSuggest, req, callId),
  identifySign: (req, callId) => ipcRenderer.invoke(IPC.identifySign, req, callId),
  onLlmStatus: (cb) => subscribe<LlmStatusEvent>(IPC.llmStatus, cb),
  cancelLlm: (callId) => ipcRenderer.send(IPC.llmCancel, callId),

  agentRun: (req) => ipcRenderer.invoke(IPC.agentRun, req),
  agentStop: () => ipcRenderer.invoke(IPC.agentStop),
  agentRespond: (requestId, approved) => ipcRenderer.invoke(IPC.agentRespond, requestId, approved),
  onAgentEvent: (cb) => subscribe<AgentEvent>(IPC.agentEvent, cb),
  runShortcut: (gestureId) => ipcRenderer.invoke(IPC.runShortcut, gestureId),

  getFrontmostApp: () => ipcRenderer.invoke(IPC.frontmostApp),
  typeText: (text) => ipcRenderer.invoke(IPC.typeText, text),
  openTarget: (action) => ipcRenderer.invoke(IPC.openTarget, action),
  getImageThumb: (path) => ipcRenderer.invoke(IPC.imageThumb, path),

  onDevCommand: (cb) => subscribe<DevCommand>(IPC.devCommand, cb),
  capture: (name) => ipcRenderer.invoke(IPC.capture, name),
  quit: () => ipcRenderer.send(IPC.quit),
  sendCaptions: (state) => ipcRenderer.send(IPC.captionsUpdate, state),
  onCaptions: (cb) => subscribe<CaptionState>(IPC.captionsState, cb)
}

contextBridge.exposeInMainWorld('fastasl', api)
