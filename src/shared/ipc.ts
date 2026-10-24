import type {
  AgentEvent,
  AgentRunRequest,
  CompletedTask,
  CustomGesture,
  DevCommand,
  FrontmostApp,
  InterpretRequest,
  IntentResult,
  KeyStatus,
  LlmStatusEvent,
  Result,
  Settings,
  ShortcutRunResult,
  SpellRequest,
  TemplatePack,
  TemplateStore,
  ViewAction
} from './types'

/** IPC channel names. invoke = request/response, send = fire and forget, on = main -> renderer. */
export const IPC = {
  // window
  setCardSize: 'window:setCardSize',
  setFocusable: 'window:setFocusable',
  // app data
  envStatus: 'app:envStatus',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  getTemplates: 'templates:get',
  saveTemplates: 'templates:save',
  importPack: 'templates:importPack',
  exportPack: 'templates:exportPack',
  getGestures: 'gestures:get',
  saveGestures: 'gestures:save',
  getRecentTasks: 'tasks:recent',
  // camera / assets
  mjpegProxyUrl: 'camera:mjpegProxyUrl',
  assetBase: 'assets:base',
  // claude (or the LLM_PROVIDER in .env)
  interpret: 'claude:interpret',
  spellSuggest: 'claude:spellSuggest',
  llmStatus: 'llm:status',
  llmCancel: 'llm:cancel',
  // agent
  agentRun: 'agent:run',
  agentStop: 'agent:stop',
  agentRespond: 'agent:respond',
  agentEvent: 'agent:event',
  runShortcut: 'shortcut:run',
  // mac
  frontmostApp: 'mac:frontmostApp',
  typeText: 'mac:typeText',
  openTarget: 'mac:openTarget',
  // dev
  devCommand: 'dev:command',
  capture: 'dev:capture',
  quit: 'app:quit'
} as const

export interface CardSize {
  width: number
  height: number
}

/** The API the preload script exposes on `window.fastasl`. */
export interface FastAslApi {
  isDev: boolean
  isScreenshotMode: boolean
  /** True when the window uses native NSVisualEffectView vibrancy (FASTASL_VIBRANCY=hud). */
  nativeVibrancy: boolean
  /** FASTASL_MOCK=1: the renderer uses mock services instead of the main process ones. */
  mockServices: boolean
  /** LLM_PROVIDER as main resolved it ("claude", "gemini", "local", "mock"), or the unknown value as written. */
  llmProvider: string

  setCardSize(size: CardSize): void
  setFocusable(focusable: boolean): void

  getEnvStatus(): Promise<KeyStatus>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  getTemplates(): Promise<TemplateStore>
  saveTemplates(store: TemplateStore): Promise<void>
  importPack(pack: TemplatePack): Promise<number>
  exportPack(): Promise<TemplatePack>
  getGestures(): Promise<CustomGesture[]>
  saveGestures(gestures: CustomGesture[]): Promise<void>
  getRecentTasks(): Promise<CompletedTask[]>

  /** Returns a same-machine URL (with CORS headers) that proxies the given MJPEG stream. */
  getMjpegProxyUrl(url: string): Promise<string>
  /** Base URL for bundled assets (MediaPipe wasm + models). */
  getAssetBase(): Promise<string>

  /** `callId` asks main for status events (onLlmStatus) while the call runs. */
  interpret(req: InterpretRequest, callId?: string): Promise<Result<IntentResult>>
  spellSuggest(req: SpellRequest, callId?: string): Promise<Result<string[]>>
  /** Status lines of running interpret / spellSuggest calls, e.g. "Rate limited, retrying...". */
  onLlmStatus(cb: (event: LlmStatusEvent) => void): () => void
  /** Aborts the interpret / spellSuggest call started with this `callId` (the card dropped it). */
  cancelLlm(callId: string): void

  agentRun(req: AgentRunRequest): Promise<Result<{ runId: string }>>
  agentStop(): Promise<void>
  agentRespond(requestId: string, approved: boolean): Promise<void>
  onAgentEvent(cb: (event: AgentEvent) => void): () => void
  runShortcut(gestureId: string): Promise<ShortcutRunResult>

  getFrontmostApp(): Promise<FrontmostApp | null>
  typeText(text: string): Promise<Result<void>>
  openTarget(action: ViewAction): Promise<void>

  onDevCommand(cb: (cmd: DevCommand) => void): () => void
  /** Screenshot mode only: capture the stage window to docs/screens/<name>.png. */
  capture(name: string): Promise<string>
  quit(): void
}
