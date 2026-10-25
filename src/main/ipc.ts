import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC, type CardSize } from '@shared/ipc'
import { createTemplatePack } from '@shared/templatePack'
import type {
  AgentEvent,
  AgentRunRequest,
  CustomGesture,
  IdentifySignRequest,
  InterpretRequest,
  LlmStatusEvent,
  Result,
  Settings,
  ShortcutRunResult,
  SignGuess,
  SpellRequest,
  TemplatePack,
  TemplateStore,
  ViewAction
} from '@shared/types'
import { contactAliases } from './agent/directCommands'
import { keyStatus } from './env'
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
  /** Guess, confirm, learn: camera frames and a motion summary in, up to 3 glosses out. */
  identifySign?: (
    req: IdentifySignRequest,
    onStatus?: (status: string) => void,
    signal?: AbortSignal
  ) => Promise<Result<SignGuess>>
  agentRun?: (req: AgentRunRequest, emit: (e: AgentEvent) => void) => Promise<Result<{ runId: string }>>
  agentStop?: () => Promise<void>
  agentRespond?: (requestId: string, approved: boolean) => Promise<void>
  runShortcut?: (gestureId: string, emit: (e: AgentEvent) => void) => Promise<ShortcutRunResult>
  frontmostApp?: () => Promise<import('@shared/types').FrontmostApp | null>
  typeText?: (text: string) => Promise<Result<void>>
  /** A screenshot's thumbnail as a PNG data URL; refuses any file fastASL didn't take (main/thumbs.ts). */
  imageThumb?: (path: unknown) => Result<string> | Promise<Result<string>>
  mjpegProxyUrl?: (url: string) => Promise<string>
  assetBase?: () => Promise<string>
  capture?: (name: string) => Promise<string>
}

const notReady = <T>(what: string): Result<T> => ({ ok: false, error: `${what} is not available yet` })

/**
 * The renderer sends at most 8 small JPEGs, a summary of a few lines and the taught word labels;
 * anything else is refused before it reaches a provider's prompt.
 */
const MAX_SIGN_FRAMES = 8
const MAX_FRAME_BASE64 = 400_000
const MAX_MOTION = 2000
const MAX_KNOWN = 500
const MAX_LABEL = 64

function isSignRequest(req: unknown): req is IdentifySignRequest {
  const r = req as Partial<IdentifySignRequest> | null
  return (
    typeof r === 'object' &&
    r !== null &&
    Array.isArray(r.frames) &&
    r.frames.length <= MAX_SIGN_FRAMES &&
    r.frames.every((f) => typeof f === 'string' && f.length <= MAX_FRAME_BASE64) &&
    typeof r.motion === 'string' &&
    r.motion.length <= MAX_MOTION &&
    (r.mode === 'command' || r.mode === 'dictation' || r.mode === 'spell') &&
    Array.isArray(r.known) &&
    r.known.length <= MAX_KNOWN &&
    r.known.every((k) => typeof k === 'string' && k.length <= MAX_LABEL)
  )
}

export function registerIpc(getOverlay: () => OverlayWindow | null, services: MainServices): void {
  const broadcast = (channel: string, event: AgentEvent | LlmStatusEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, event)
    }
  }
  const emitAgent = (event: AgentEvent): void => broadcast(IPC.agentEvent, event)
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
  ipcMain.handle(IPC.contactAliases, () => Object.fromEntries(contactAliases()))
  ipcMain.handle(IPC.getSettings, () => store.getSettings())
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<Settings>) => store.saveSettings(patch))
  ipcMain.handle(IPC.getTemplates, () => store.getTemplates())
  ipcMain.handle(IPC.saveTemplates, (_e, value: TemplateStore) => store.saveTemplates(value))
  ipcMain.handle(IPC.importPack, (_e, pack: unknown) => {
    const result = store.importTemplatePack(pack)
    if (result instanceof Error) throw result
    return result.added
  })
  ipcMain.handle(IPC.exportPack, (): TemplatePack => createTemplatePack(store.getTemplates().templates))
  ipcMain.handle(IPC.getGestures, () => store.getGestures())
  ipcMain.handle(IPC.saveGestures, (_e, list: CustomGesture[]) => store.saveGestures(list))
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
  ipcMain.handle(IPC.identifySign, (_e, req: IdentifySignRequest, callId?: string) => {
    const { identifySign } = services
    if (!identifySign) return notReady('Sign guessing')
    if (!isSignRequest(req)) return { ok: false, error: 'Bad sign request' }
    return llmCall(callId, (onStatus, signal) => identifySign(req, onStatus, signal))
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

  ipcMain.handle(IPC.imageThumb, (_e, path: unknown) =>
    services.imageThumb ? services.imageThumb(path) : notReady<string>('Thumbnails')
  )

  ipcMain.handle(IPC.capture, (_e, name: string) => services.capture?.(name) ?? '')
}
