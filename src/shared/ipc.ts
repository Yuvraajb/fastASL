import type {
  AgentEvent,
  AgentRunRequest,
  CompletedTask,
  CustomGesture,
  DevCommand,
  FrontmostApp,
  IdentifySignRequest,
  InterpretRequest,
  IntentResult,
  KeyStatus,
  LlmStatusEvent,
  Result,
  Settings,
  ShortcutRunResult,
  SignGuess,
  SpellRequest,
  TemplatePack,
  TemplateStore,
  ViewAction,
  CaptionState
} from './types'

/** IPC channel names. invoke = request/response, send = fire and forget, on = main -> renderer. */
export const IPC = {
  // window
  setCardSize: 'window:setCardSize',
  setFocusable: 'window:setFocusable',
  // app data
  envStatus: 'app:envStatus',
  contactAliases: 'app:contactAliases',
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
  identifySign: 'llm:identifySign',
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
  imageThumb: 'mac:imageThumb',
  // dev
  devCommand: 'dev:command',
  capture: 'dev:capture',
  quit: 'app:quit',
  // caption camera (FaceTime via OBS Virtual Camera)
  captionsUpdate: 'captions:update',
  captionsState: 'captions:state',
  captionsOpen: 'captions:open',
  captionsOpenChanged: 'captions:open-changed',
  captionsTranslate: 'captions:translate'
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
  /** FASTASL_CONTACT_ALIASES: sign word (lower case) -> full name in Contacts (FRIEND -> Darren Wu). */
  getContactAliases(): Promise<Record<string, string>>
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
  /** Guess, confirm, learn: names a movement the local recognizer didn't know, from camera frames. */
  identifySign(req: IdentifySignRequest, callId?: string): Promise<Result<SignGuess>>
  /** Status lines of running LLM calls, e.g. "Rate limited, retrying...". */
  onLlmStatus(cb: (event: LlmStatusEvent) => void): () => void
  /** Aborts the LLM call started with this `callId` (the card dropped it). */
  cancelLlm(callId: string): void

  agentRun(req: AgentRunRequest): Promise<Result<{ runId: string }>>
  agentStop(): Promise<void>
  agentRespond(requestId: string, approved: boolean): Promise<void>
  onAgentEvent(cb: (event: AgentEvent) => void): () => void
  runShortcut(gestureId: string): Promise<ShortcutRunResult>

  getFrontmostApp(): Promise<FrontmostApp | null>
  typeText(text: string): Promise<Result<void>>
  openTarget(action: ViewAction): Promise<void>
  /**
   * A small PNG data URL (320 px wide) of a screenshot fastASL took this session. Any other
   * path is refused.
   */
  getImageThumb(path: string): Promise<Result<string>>

  onDevCommand(cb: (cmd: DevCommand) => void): () => void
  /** Screenshot mode only: capture the stage window to docs/screens/<name>.png. */
  capture(name: string): Promise<string>
  quit(): void
  /** Overlay: what the caption camera should show now. */
  sendCaptions(state: CaptionState): void
  /** Caption window: the latest captions. */
  onCaptions(cb: (state: CaptionState) => void): () => void
  /** Overlay: whether the caption camera window is open now. */
  captionsOpen(): Promise<boolean>
  /** Overlay: the caption camera window opened or closed. */
  onCaptionsOpen(cb: (open: boolean) => void): () => void
  /** Overlay: signed glosses (ASL order) as one English sentence for the captions (local Ollama). */
  captionsTranslate(glosses: string[]): Promise<Result<string>>
}
