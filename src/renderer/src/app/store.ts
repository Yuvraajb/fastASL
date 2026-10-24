import { create } from 'zustand'
import type { CameraSource, CustomGesture, KeyStatus, Mode, Sensitivity, SignTemplate } from '@shared/types'
import type { View } from './types'

export interface PickProgress {
  /** 1-based option number currently being held. */
  count: number
  /** 0..1 progress of the 0.8s hold. */
  progress: number
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
  /** Number of hands currently visible (0-2). */
  handsVisible: number
  /**
   * A movement is being judged as a sign: the header says "Listening..." while the card stays as
   * it is (switching cards for every movement resized the window each time).
   */
  signing: boolean
  /** Recorded signs (signs.json), loaded by the controller; recognition follows this list. */
  templates: SignTemplate[]
  /** Gesture shortcuts (gestures.json), loaded by the controller; the shape matcher follows this list. */
  gestures: CustomGesture[]
  /**
   * The words the pretrained sign model recognizes (upper case), once it has loaded: a sign
   * guess tells the LLM about them, so it names them the way the model does.
   */
  modelWords: string[]
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
  signing: false,
  templates: [],
  gestures: [],
  modelWords: []
}))

export const getApp = (): AppState => useApp.getState()
export const setApp = (patch: Partial<AppState>): void => useApp.setState(patch)
