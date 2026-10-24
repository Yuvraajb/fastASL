import type { AgentStep, ConfirmDetails, CustomGesture, Mode, Sensitivity, ViewAction } from '@shared/types'

/** A token in the building strip: a fingerspelled letter or a recognized word. */
export interface Token {
  text: string
  kind: 'letter' | 'word'
}

export type SettingsPage =
  | { page: 'root' }
  /** `recorded`: templates per label, for the list's counts. */
  | { page: 'teachPick'; offset: number; recorded: Record<string, number> }
  /** `canSpell`: some letter is taught, so the word can be fingerspelled (else only typed). */
  | { page: 'teachSpell'; letters: string; canSpell: boolean }
  | {
      page: 'teachRecord'
      label: string
      kind: 'word' | 'letter'
      done: number
      total: number
      /** A movement is being recorded. */
      listening?: boolean
      /** Why the last repetition was not kept. */
      reason?: string
    }
  | { page: 'newGesturePick'; tasks: string[] }
  | {
      page: 'newGestureHold'
      task: string
      /** 3, 2, 1 before the shape is recorded; 0 while recording (and after a refusal). */
      countdown: number
      /** Why the recorded shape was refused; thumbs up records again. */
      reason?: string
    }
  /** `offset`: index of the first gesture on the page (swipes page through the list). */
  | { page: 'gestures'; gestures: Pick<CustomGesture, 'id' | 'name' | 'task' | 'builtin'>[]; offset: number }
  | { page: 'gestureDetail'; gesture: Pick<CustomGesture, 'id' | 'name' | 'task' | 'builtin'> }
  | { page: 'camera'; current: 'builtin' | 'mjpeg'; url: string }
  | { page: 'sensitivity'; current: Sensitivity }

/** Every card state. Exactly one is shown at a time. */
export type View =
  | { kind: 'collapsed' }
  | { kind: 'ready'; hint?: string }
  | { kind: 'recognizing'; token: string | null; isWord: boolean }
  | { kind: 'building'; tokens: Token[]; current: string | null; sentence: string }
  | { kind: 'sentence'; sentence: string; tokens: Token[]; thinking?: boolean }
  | {
      kind: 'agentReady'
      intent: string
      /** "email" variant shows a recipient row + full-width Send / Change buttons (ref image 2). */
      variant: 'default' | 'email'
      target?: string
      sentence: string
    }
  | { kind: 'working'; intent: string; steps: AgentStep[] }
  | { kind: 'confirm'; requestId: string; details: ConfirmDetails }
  | {
      kind: 'didYouMean'
      /** list = numbered alternatives (pick by fingers); quote = "Yes, send" / "Edit". */
      variant: 'list' | 'quote'
      quote?: string
      options: string[]
      purpose: 'sign' | 'intent' | 'spell'
      /** Spell: Claude's spellings are on their way (the raw letters can be picked meanwhile). */
      pending?: boolean
    }
  | { kind: 'done'; title: string; subtitle: string; ok: boolean; view?: ViewAction; intent?: string }
  | { kind: 'contextActions'; sentence: string; actions: string[] }
  /** `fromSentence`: opened by Context actions › More options, so a pick applies to the signed sentence. */
  | { kind: 'quickMenu'; options: string[]; fromSentence?: boolean }
  | { kind: 'dictation'; text: string }
  | {
      kind: 'toast'
      title: string
      subtitle?: string
      meta?: string
      ok: boolean
      /** Where the card goes afterwards: the pill, the idle view, or a settings page (after teaching a sign). */
      returnTo: 'collapsed' | 'ready' | SettingsPage
    }
  | { kind: 'settings'; settings: SettingsPage }

export type ViewKind = View['kind']

export type StatusTone = 'active' | 'idle'

export interface StatusInfo {
  label: string
  tone: StatusTone
}

/** Default card width per state (px). Collapsed / toast size to content. */
export function cardWidth(view: View): number {
  switch (view.kind) {
    case 'agentReady':
    case 'confirm':
    case 'done':
      return 340
    case 'toast':
      return 320
    default:
      return 300
  }
}

/** Status label shown top-right of the card header. */
export function statusFor(view: View, mode: Mode): StatusInfo | null {
  switch (view.kind) {
    case 'collapsed':
    case 'toast':
      return null
    case 'ready':
      if (mode === 'dictation') return { label: 'Dictating...', tone: 'active' }
      return { label: 'Ready', tone: 'active' }
    case 'recognizing':
      return view.token ? { label: 'Recognizing...', tone: 'idle' } : { label: 'Listening...', tone: 'active' }
    case 'building':
      return { label: 'Building...', tone: 'idle' }
    case 'sentence':
      return { label: 'Sentence', tone: 'idle' }
    case 'agentReady':
      return { label: 'Agent ready', tone: 'active' }
    case 'working':
      return { label: 'Working...', tone: 'idle' }
    case 'confirm':
      return { label: 'Confirm', tone: 'idle' }
    case 'didYouMean':
      return { label: 'Confirm', tone: 'idle' }
    case 'done':
      return { label: 'Done', tone: view.ok ? 'active' : 'idle' }
    case 'contextActions':
      return { label: 'Sentence', tone: 'idle' }
    case 'quickMenu':
      return { label: 'Ready', tone: 'active' }
    case 'dictation':
      return { label: 'Dictating...', tone: 'active' }
    case 'settings':
      return { label: 'Settings', tone: 'idle' }
  }
}

export const MODE_LABEL: Record<Mode, string> = {
  command: 'Command',
  dictation: 'Dictation',
  spell: 'Spell'
}
