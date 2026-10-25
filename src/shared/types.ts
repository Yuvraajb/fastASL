// Types shared by the main process, preload bridge and renderer.
// Anything that crosses IPC lives here.

export type Mode = 'command' | 'dictation' | 'spell'

export type Sensitivity = 'low' | 'medium' | 'high'

export type CameraSource = { kind: 'builtin'; deviceId?: string } | { kind: 'mjpeg'; url: string }

export interface Settings {
  cameraSource: CameraSource
  cameraEnabled: boolean
  sensitivity: Sensitivity
  mode: Mode
  /**
   * The ESP32-CAM stream URL, kept while the MacBook camera is in use. Until one is typed
   * in Settings › Camera source, FASTASL_MJPEG_URL from .env (or '').
   */
  streamUrl: string
}

export type EnvKey =
  | 'ANTHROPIC_API_KEY'
  | 'GEMINI_API_KEY'
  | 'FACTORY_API_KEY'
  | 'SPOTIFY_CLIENT_ID'
  | 'SPOTIFY_CLIENT_SECRET'

export type KeyStatus = Record<EnvKey, boolean>

/** Result wrapper for IPC calls that can fail softly (missing key, osascript error...). */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; missingKey?: EnvKey }

// ---------------------------------------------------------------------------
// Hand tracking & recognition data

export interface Landmark {
  x: number
  y: number
  z: number
}

export type Handedness = 'Left' | 'Right'

/** One recorded sign / letter / custom shape. Frames are normalized feature vectors. */
export interface SignTemplate {
  id: string
  label: string
  kind: 'word' | 'letter'
  frames: number[][]
  createdAt: number
}

export interface TemplateStore {
  version: 1
  templates: SignTemplate[]
}

/** A template pack is the export format shared between team members. */
export interface TemplatePack {
  format: 'fastasl-template-pack'
  version: 1
  exportedAt: string
  templates: SignTemplate[]
}

// ---------------------------------------------------------------------------
// Context, intent (Claude)

export interface FrontmostApp {
  name: string
  bundleId?: string
  windowTitle?: string
}

export interface InterpretRequest {
  tokens: string[]
  sentence: string
  mode: Mode
  /** Optional prefix chosen from the quick menu, e.g. "Create event". */
  intentPrefix?: string
  frontmost: FrontmostApp | null
  gestures: { name: string; task: string }[]
}

/** Strict JSON contract returned by the LLM (every LLM_PROVIDER). */
export interface IntentResult {
  sentence: string
  intent: string | null
  alternatives: string[]
  confidence: number
  needs_confirmation: boolean
  context_actions: string[]
}

export interface SpellRequest {
  letters: string
  frontmost: FrontmostApp | null
}

/**
 * Guess, confirm, learn: a movement the local recognizer didn't know, sent to the LLM to name.
 * Frames leave the Mac only in this request, and only on a real provider (claude, gemini, local).
 */
export interface IdentifySignRequest {
  /** 3 to 8 camera frames across the movement, oldest first: JPEG, base64 without the data: prefix. */
  frames: string[]
  /** Measured from hand tracking: hands, handshape at start and end, movement, duration. */
  motion: string
  mode: Mode
  /** Words the user has taught, so the model can name one it plausibly is. */
  known: string[]
}

export interface SignCandidate {
  /** Upper-case English gloss: one word or a short phrase ("HELLO", "THANK YOU"). */
  gloss: string
  /** 0 to 1. */
  confidence: number
  /** How many hands the sign uses in standard ASL: a one-handed sign is learned without the other hand. */
  hands: 1 | 2
}

/** Strict JSON contract of identifySign (every LLM_PROVIDER). At most 3 candidates, most likely first. */
export interface SignGuess {
  is_sign: boolean
  candidates: SignCandidate[]
}

/** Which LLM answers interpret and spellSuggest (LLM_PROVIDER in .env; unset = claude). */
export type LlmProviderName = 'claude' | 'gemini' | 'local' | 'mock' | 'droid'

/** Main -> renderer while an interpret / spellSuggest / identifySign call runs, e.g. "Rate limited, retrying...". */
export interface LlmStatusEvent {
  /** The id the renderer passed with the call. */
  callId: string
  status: string
}

// ---------------------------------------------------------------------------
// Agent (Factory Droid) events

export type StepStatus = 'done' | 'current' | 'pending' | 'error'

export interface AgentStep {
  id: string
  label: string
  status: StepStatus
}

export type ConfirmDetails =
  | {
      kind: 'event'
      title: string
      dateLabel: string
      timeLabel: string
      guestsLabel?: string
      videoLabel?: string
    }
  | { kind: 'mail'; to: string; subject: string; body: string }
  | { kind: 'message'; to: string; text: string }
  | { kind: 'generic'; title: string; lines: string[] }

export interface ToolCallRecord {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  /** Short, human readable result produced by the tool implementation itself. */
  result?: string
}

export type ViewAction =
  | { kind: 'openApp'; app: string }
  | { kind: 'openUrl'; url: string }
  | { kind: 'openFile'; path: string }

export interface AgentResult {
  /** Title/subtitle are derived from tool results, never from the model's own claim. */
  title: string
  subtitle: string
  evidence: ToolCallRecord[]
  view?: ViewAction
  /**
   * The model's own final reply, from a turn that finished normally (never a declined, stopped or
   * failed one). With no evidence it is the answer itself (a greeting, a question); after tools
   * it is a secondary line under the evidence-based title.
   */
  reply?: string
}

export type AgentEvent =
  | { type: 'started'; runId: string; intent: string }
  | { type: 'step'; runId: string; step: AgentStep }
  | { type: 'confirm'; runId: string; requestId: string; tool: string; details: ConfirmDetails }
  /** `complete`: the whole task got done. A declined or half-finished task still ends in 'done' (whatever ran is reported). */
  | { type: 'done'; runId: string; result: AgentResult; complete: boolean }
  | { type: 'error'; runId: string; message: string; missingKey?: EnvKey }
  | { type: 'stopped'; runId: string }

export interface AgentRunRequest {
  intent: string
  sentence: string
  frontmost: FrontmostApp | null
}

// ---------------------------------------------------------------------------
// Custom gesture shortcuts

export interface CustomGesture {
  id: string
  name: string
  /** Plain-English task, e.g. "Take a screenshot" or "Play Motion Sickness". */
  task: string
  /** Static handshape samples (normalized single-frame feature vectors). */
  shape: number[][]
  /** Exact tool-call sequence recorded on the first successful agent run. */
  compiled?: ToolCallRecord[]
  builtin?: boolean
  createdAt: number
}

export interface ShortcutRunResult {
  ok: boolean
  title: string
  subtitle: string
  compiled: boolean
  durationMs: number
  /** What the result opens (the peace sign's screenshot), from the tool outcome. */
  view?: ViewAction
}

export interface CompletedTask {
  intent: string
  title: string
  at: number
  evidence: ToolCallRecord[]
}

// ---------------------------------------------------------------------------
// Dev tooling

export type SimGesture =
  | 'palmHold'
  | 'swipeLeft'
  | 'swipeRight'
  | 'swipeUp'
  | 'thumbsUp'
  | 'fist'
  | 'fingers1'
  | 'fingers2'
  | 'fingers3'
  | 'fingers4'
  | 'fingers5'
  | 'handsDown'
  | 'signToken'
  | 'peace'

export type DevCommand =
  | { type: 'setView'; id: string }
  | { type: 'gesture'; gesture: SimGesture }
  | { type: 'toggleDevPanel' }
  /** signs.json changed outside the renderer (tray pack import): reload it. */
  | { type: 'templatesChanged' }

/** What the caption camera shows (overlay -> main -> caption window). */
export interface CaptionState {
  /** The words being signed right now, as they stream in. */
  live: string
  /** The last message sent (shown for a while after the hands drop). */
  last: string
  /** When `last` was sent (Date.now()), to fade it out. */
  lastAt: number
}

