import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC, type CardSize } from '@shared/ipc'
import { createTemplatePack } from '@shared/templatePack'
import type {
  AgentEvent,
  ChatEvent,
  AgentRunRequest,
  CustomGesture,
  InterpretRequest,
  LlmStatusEvent,
  Result,
  Settings,
  ShortcutRunResult,
  SpellRequest,
  TemplatePack,
  TemplateStore,
  ViewAction
} from '@shared/types'
import { keyStatus } from './env'
import * as cloud from './cloud'
import * as store from './store'
import type { OverlayWindow } from './window'

/**
 * Services implemented by later phases. Each one is optional so the app always
 * runs; a missing service answers with a soft error the card can show.
 */
export interface MainServices {
  /**
   * `onStatus` reaches the card as a one-line notice while the call runs ("Rate limited, retrying...").
   * `signal` aborts when the card drops the call (IPC.llmCancel).
   */
  interpret?: (
    req: InterpretRequest,
    onStatus?: (status: string) => void,
    signal?: AbortSignal
  ) => Promise<Result<import('@shared/types').IntentResult>>
  spellSuggest?: (
    req: SpellRequest,
    onStatus?: (status: string) => void,
    signal?: AbortSignal
  ) => Promise<Result<string[]>>
  agentRun?: (req: AgentRunRequest, emit: (e: AgentEvent) => void) => Promise<Result<{ runId: string }>>
  agentStop?: () => Promise<void>
  agentRespond?: (requestId: string, approved: boolean) => Promise<void>
  runShortcut?: (gestureId: string, emit: (e: AgentEvent) => void) => Promise<ShortcutRunResult>
  chatSend?: (id: string, text: string, emit: (e: ChatEvent) => void) => Result<void>
  chatStop?: () => void
  chatReset?: () => Promise<void>
  frontmostApp?: () => Promise<import('@shared/types').FrontmostApp | null>
  typeText?: (text: string) => Promise<Result<void>>
  mjpegProxyUrl?: (url: string) => Promise<string>
  assetBase?: () => Promise<string>
  capture?: (name: string) => Promise<string>
}

const notReady = <T>(what: string): Result<T> => ({ ok: false, error: `${what} is not available yet` })

export function registerIpc(getOverlay: () => OverlayWindow | null, services: MainServices): void {
  const broadcast = (channel: string, event: AgentEvent | LlmStatusEvent | ChatEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, event)
    }
  }
  const emitAgent = (event: AgentEvent): void => broadcast(IPC.agentEvent, event)
  const emitChat = (event: ChatEvent): void => broadcast(IPC.chatEvent, event)
  /** LLM calls still running, by the id their renderer picked, so the card can cancel them. */
  const llmCalls = new Map<string, AbortController>()
  /**
   * Runs one LLM call. With an id, its status lines go out tagged with it and IPC.llmCancel can
   * abort it; without one it gets neither.
   */
  function llmCall<T>(
    callId: unknown,
    run: (onStatus?: (status: string) => void, signal?: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (typeof callId !== 'string' || !callId) return run()
    const ctl = new AbortController()
    llmCalls.set(callId, ctl)
    return run((status) => broadcast(IPC.llmStatus, { callId, status }), ctl.signal).finally(() => {
      if (llmCalls.get(callId) === ctl) llmCalls.delete(callId)
    })
  }

  ipcMain.on(IPC.setCardSize, (e, size: CardSize) => {
    const overlay = getOverlay()
    if (overlay && e.sender === overlay.win.webContents) overlay.setCardSize(size)
  })
  ipcMain.on(IPC.setFocusable, (_e, focusable: boolean) => getOverlay()?.setFocusable(Boolean(focusable)))

  ipcMain.handle(IPC.envStatus, () => keyStatus())
  ipcMain.handle(IPC.getSettings, () => store.getSettings())
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<Settings>) => store.saveSettings(patch))
  ipcMain.handle(IPC.getTemplates, async () => {
    await cloud.syncOnce()
    return store.getTemplates()
  })
  ipcMain.handle(IPC.saveTemplates, (_e, value: TemplateStore) => {
    store.saveTemplates(value)
    cloud.pushLater(() => cloud.pushTemplates(value.templates))
  })
  ipcMain.handle(IPC.importPack, (_e, pack: unknown) => {
    const result = store.importTemplatePack(pack)
    if (result instanceof Error) throw result
    return result.added
  })
  ipcMain.handle(IPC.exportPack, (): TemplatePack => createTemplatePack(store.getTemplates().templates))
  ipcMain.handle(IPC.getGestures, async () => {
    await cloud.syncOnce()
    return store.getGestures()
  })
  ipcMain.handle(IPC.saveGestures, (_e, list: CustomGesture[]) => {
    store.saveGestures(list)
    cloud.pushLater(() => cloud.pushGestures(list))
  })
  ipcMain.handle(IPC.getRecentTasks, () => store.getRecentTasks())

  ipcMain.handle(IPC.mjpegProxyUrl, (_e, url: string) => services.mjpegProxyUrl?.(url) ?? url)
  ipcMain.handle(IPC.assetBase, () => services.assetBase?.() ?? '')

  ipcMain.handle(IPC.interpret, (_e, req: InterpretRequest, callId?: string) => {
    const { interpret } = services
    return interpret ? llmCall(callId, (onStatus, signal) => interpret(req, onStatus, signal)) : notReady('Claude')
  })
  ipcMain.handle(IPC.spellSuggest, (_e, req: SpellRequest, callId?: string) => {
    const { spellSuggest } = services
    return spellSuggest ? llmCall(callId, (onStatus, signal) => spellSuggest(req, onStatus, signal)) : notReady('Claude')
  })
  ipcMain.on(IPC.llmCancel, (_e, callId: unknown) => {
    if (typeof callId === 'string') llmCalls.get(callId)?.abort()
  })

  ipcMain.handle(IPC.agentRun, (_e, req: AgentRunRequest) =>
    services.agentRun ? services.agentRun(req, emitAgent) : notReady('The agent')
  )
  ipcMain.handle(IPC.agentStop, () => services.agentStop?.())
  ipcMain.handle(IPC.agentRespond, (_e, requestId: string, approved: boolean) =>
    services.agentRespond?.(requestId, approved)
  )
  ipcMain.handle(IPC.chatSend, (_e, id: string, text: string): Result<void> =>
    services.chatSend ? services.chatSend(id, text, emitChat) : notReady('Chat')
  )
  ipcMain.handle(IPC.chatStop, () => services.chatStop?.())
  ipcMain.handle(IPC.chatReset, () => services.chatReset?.())
  ipcMain.handle(IPC.runShortcut, async (_e, gestureId: string): Promise<ShortcutRunResult> =>
    services.runShortcut
      ? services.runShortcut(gestureId, emitAgent)
      : { ok: false, title: 'Shortcut unavailable', subtitle: 'Not implemented yet', compiled: false, durationMs: 0 }
  )

  ipcMain.handle(IPC.frontmostApp, () => services.frontmostApp?.() ?? null)
  ipcMain.handle(IPC.typeText, (_e, text: string) =>
    services.typeText ? services.typeText(text) : notReady('Typing')
  )
  ipcMain.handle(IPC.openTarget, async (_e, action: ViewAction) => {
    if (action.kind === 'openUrl') await shell.openExternal(action.url)
    else if (action.kind === 'openFile') await shell.openPath(action.path)
    else if (action.kind === 'openApp') {
      const { execFile } = await import('child_process')
      execFile('open', ['-a', action.app])
    }
  })

  ipcMain.handle(IPC.capture, (_e, name: string) => services.capture?.(name) ?? '')
}
