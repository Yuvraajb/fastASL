import type { AgentStep, ConfirmDetails, CustomGesture, Mode, Sensitivity, ViewAction } from '@shared/types'

/** The chat transcript keeps about this many messages for the session (the oldest go first). */
export const MAX_CHAT = 20

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
  /**
   * Teach › Show me a sign: one clean repetition, guessed by the LLM, confirmed by a pick.
   * waiting -> listening (a movement started) -> identifying (the LLM is asked) -> guess.
   */
  | {
      page: 'teachShow'
      phase: 'waiting' | 'listening' | 'identifying' | 'guess'
      /** The LLM's glosses (guess), most likely first; "None of these" follows them on screen. */
      guesses?: string[]
      /** Why the last attempt gave no guess (not a sign, too long, the LLM's error). */
      reason?: string
    }
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
  /** `editing`: the stream URL field is open (Edit stream URL); the keyboard saves it. */
  | { page: 'camera'; current: 'builtin' | 'mjpeg'; url: string; editing?: boolean }
  | { page: 'sensitivity'; current: Sensitivity }

/**
 * The agent's answer on the conversation card. With `title` it did something (or failed): the
 * title and subtitle come from tool outcomes or the error, as the old Done card's did, and `text`
 * is the model's own short line under them. Without `title`, `text` is the answer itself (a
 * greeting, a question about the time): the agent ran no tool.
 */
export interface Answer {
  /** The task got done, or the agent answered in words. False: it failed or stopped short. */
  ok: boolean
  title?: string
  subtitle?: string
  text?: string
  /** What the result opens (thumbs up): the screenshot in Preview, Calendar, a search. */
  view?: ViewAction
  /** A screenshot's thumbnail (PNG data URL). */
  thumb?: string
}

/** A write the agent asked to make: waiting for a thumbs up or a fist, or answered. */
export type ConfirmStatus = 'pending' | 'allowed' | 'cancelled'

/**
 * One bubble of Command mode's chat transcript (store.chat). The transcript keeps the session's
 * last MAX_CHAT messages; the controller adds to it at each point of the exchange.
 */
export type ChatMessage =
  /** What the user signed: the raw words, then the interpreter's sentence. `prefix`: a quick-menu pick. */
  | { id: string; from: 'you'; kind: 'text'; text: string; prefix?: string }
  /** The agent's words (no tool ran, or only lookups). */
  | { id: string; from: 'agent'; kind: 'text'; text: string }
  /**
   * The agent at work: "Understanding", then its live steps. At most one, always the last
   * bubble, replaced by the answer when the run ends.
   */
  | { id: string; from: 'agent'; kind: 'steps'; steps: AgentStep[] }
  /** What the agent did (an `Answer` with a title): badge or screenshot, title, subtitle, its own line. */
  | { id: string; from: 'agent'; kind: 'result'; answer: Answer }
  /** A write that waits for a thumbs up (allow) or a fist (cancel), shown inline. */
  | { id: string; from: 'agent'; kind: 'confirm'; requestId: string; details: ConfirmDetails; status: ConfirmStatus }
  /** The agent couldn't start or finish. */
  | { id: string; from: 'agent'; kind: 'error'; title: string; subtitle?: string }
  /** A quiet centered line: "Stopped", "Cancelled". */
  | { id: string; from: 'agent'; kind: 'note'; text: string }

/** The message being signed (store.composing): its tokens as they stream in, and what it is for. */
export interface Composing {
  tokens: Token[]
  /** A quick-menu pick ("Create event") or "Gesture task" (New gesture › Sign a new task). */
  label?: string
}

/** Every card state. Exactly one is shown at a time. */
export type View =
  | { kind: 'collapsed' }
  | { kind: 'ready'; hint?: string }
  | { kind: 'recognizing'; token: string | null; isWord: boolean }
  | { kind: 'building'; tokens: Token[]; current: string | null; sentence: string }
  /**
   * Command mode: one exchange with the agent, on one card. understanding: the interpreter reads
   * the phrase; working: the agent runs (its live steps); reply: its answer. The reply card stays
   * ready: the next recognized sign starts a new phrase.
   */
  | {
      kind: 'conversation'
      phase: 'understanding' | 'working' | 'reply'
      /** What the user signed: the assembled phrase, then the interpreter's sentence once it answered. */
      said: string
      /** A quick-menu pick the phrase was signed for ("Create event"). */
      prefix?: string
      /** The agent's live steps (working). */
      steps: AgentStep[]
      /** The agent's answer (reply). */
      answer?: Answer
    }
  /** Agent runs that are not a conversation (a gesture shortcut's agent fallback). */
  | { kind: 'working'; intent: string; steps: AgentStep[] }
  /**
   * `inChat`: a command's write, asked inline on the chat card (Command mode). Without it, a
   * gesture shortcut's write on the plain Confirm card. The gestures are the same either way.
   */
  | { kind: 'confirm'; requestId: string; details: ConfirmDetails; inChat?: boolean }
  | {
      /** Numbered alternatives, picked by fingers. */
      kind: 'didYouMean'
      quote?: string
      options: string[]
      /**
       * sign: recognition was unsure between signs. learn: the LLM's guesses for a movement
       * nothing matched ("Is this HELLO?"); a pick adds the word and learns it. spell: Spell
       * mode's spellings of the letters. meeting: MEETING FRIEND's time, 1-4 PM by fingers.
       */
      purpose: 'sign' | 'spell' | 'learn' | 'meeting'
      /** Spell: Claude's spellings are on their way (the raw letters can be picked meanwhile). */
      pending?: boolean
    }
  | { kind: 'quickMenu'; options: string[] }
  | { kind: 'dictation'; text: string }
  | {
      kind: 'toast'
      title: string
      subtitle?: string
      meta?: string
      ok: boolean
      /** What the result opens: thumbs up (or the thumbnail) opens it. */
      view?: ViewAction
      /** A screenshot's thumbnail (PNG data URL), shown instead of the camera tile. */
      thumb?: string
      /** Where the card goes afterwards: the pill, the idle view, or a settings page (after teaching a sign). */
      returnTo: 'collapsed' | 'ready' | SettingsPage
    }
  | { kind: 'settings'; settings: SettingsPage }

export type ViewKind = View['kind']

/** The conversation card showing the agent's answer: it takes signs, like Ready. */
export function isReply(view: View): view is Extract<View, { kind: 'conversation' }> & { phase: 'reply' } {
  return view.kind === 'conversation' && view.phase === 'reply'
}

export type StatusTone = 'active' | 'idle'

export interface StatusInfo {
  label: string
  tone: StatusTone
}

/** The views Command mode shows as one chat card (camera, transcript, footer). */
export type ChatCardView = Extract<View, { kind: 'ready' | 'recognizing' | 'building' | 'conversation' | 'confirm' }>

/**
 * Command mode's one card: Ready, the message being signed (Recognizing, Building), the exchange
 * with the agent (conversation) and its inline Confirm are phases of the same chat card. Spell
 * mode keeps its own Ready, Recognizing and Building cards; a shortcut's Confirm stays a card.
 */
export function isChatCard(view: View, mode: Mode): boolean {
  switch (view.kind) {
    case 'conversation':
      return true
    case 'confirm':
      return view.inChat === true
    case 'ready':
    case 'recognizing':
    case 'building':
      return mode === 'command'
    default:
      return false
  }
}

/** Default card width per state (px). Collapsed / toast size to content. */
export function cardWidth(view: View, mode: Mode = 'command'): number {
  if (isChatCard(view, mode)) return 340
  switch (view.kind) {
    case 'conversation':
    case 'confirm':
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
    case 'conversation': {
      const answer = view.answer
      if (view.phase !== 'reply' || !answer) return { label: 'Working...', tone: 'idle' }
      // An answer in words is a reply; a task (or a failure) is done, as on the old Done card.
      if (answer.title === undefined) return { label: 'Reply', tone: 'active' }
      return { label: 'Done', tone: answer.ok ? 'active' : 'idle' }
    }
    case 'working':
      return { label: 'Working...', tone: 'idle' }
    case 'confirm':
      return { label: 'Confirm', tone: 'idle' }
    case 'didYouMean':
      return { label: 'Confirm', tone: 'idle' }
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
