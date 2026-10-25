import { create } from 'zustand'
import type { AgentStep, CameraSource, ConfirmDetails, CustomGesture, KeyStatus, Mode, Sensitivity, SignTemplate } from '@shared/types'
import type { View } from './types'

export interface PickProgress {
  /** 1-based option number currently being held. */
  count: number
  /** 0..1 progress of the 0.8s hold. */
  progress: number
}

/** What the agent is doing for one chat message: the live steps, a question, a confirmation, the result. */
export interface ChatAgent {
  steps: AgentStep[]
  /** The agent needs one detail (AM or PM?): sign the option's number, or click it. */
  ask: { question: string; options: string[] } | null
  /** A write waiting for thumbs up (go) or a fist (cancel). */
  confirm: { requestId: string; details: ConfirmDetails } | null
  /** How the run ended, built from tool results. */
  result: { ok: boolean; title: string; subtitle: string } | null
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Assistant only: still being written, finished, or failed (then `text` is the reason). */
  status?: 'streaming' | 'done' | 'error'
  /** Assistant only: the agent run behind this message. */
  agent?: ChatAgent
}

export interface ChatState {
  messages: ChatMessage[]
  /** The message being composed: signed words land here, and it can be edited before sending. */
  draft: string
  busy: boolean
}

export interface AppState {
  view: View
  mode: Mode
  sensitivity: Sensitivity
  cameraOn: boolean
  /** Saved camera source; app/engines.ts applies changes to the running camera. */
  cameraSource: CameraSource
  /** The ESP32-CAM stream URL (Settings › Camera source), kept while the MacBook camera is in use. */
  streamUrl: string
  /** 0..1 progress of the open-palm hold that expands the collapsed pill. */
  holdProgress: number
  /** Finger-count hold in progress (menus). */
  pick: PickProgress | null
  /** Short one-line notice, e.g. "Add ANTHROPIC_API_KEY to .env". */
  notice: string | null
  keyStatus: KeyStatus
  devPanel: boolean
  /** Shown briefly in the header after a mode switch. */
  modeFlashAt: number
  /**
   * Push to listen: when true, signs are recognized only while `listening` (the mic button held,
   * or Option+Space toggled). The app turns this on at startup; tests leave it off.
   */
  pushToListen: boolean
  listening: boolean
  /** Number of hands currently visible (0-2). */
  handsVisible: number
  /** Recorded signs (signs.json), loaded by the controller; recognition follows this list. */
  templates: SignTemplate[]
  /** The chat with the AI (signed words become a draft you can edit, then send). */
  chat: ChatState
  /** Gesture shortcuts (gestures.json), loaded by the controller; the shape matcher follows this list. */
  gestures: CustomGesture[]
}

export const useApp = create<AppState>(() => ({
  view: { kind: 'ready' },
  mode: 'command',
  sensitivity: 'medium',
  cameraOn: true,
  cameraSource: { kind: 'builtin' },
  streamUrl: '',
  holdProgress: 0,
  pick: null,
  notice: null,
  keyStatus: {
    ANTHROPIC_API_KEY: false,
    GEMINI_API_KEY: false,
    FACTORY_API_KEY: false,
    SPOTIFY_CLIENT_ID: false,
    SPOTIFY_CLIENT_SECRET: false
  },
  devPanel: false,
  modeFlashAt: 0,
  handsVisible: 0,
  pushToListen: false,
  listening: false,
  templates: [],
  chat: { messages: [], draft: '', busy: false },
  gestures: []
}))

export const getApp = (): AppState => useApp.getState()
export const setApp = (patch: Partial<AppState>): void => useApp.setState(patch)
