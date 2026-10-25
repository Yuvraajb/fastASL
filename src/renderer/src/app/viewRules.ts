import type { Mode } from '@shared/types'
import { getApp } from './store'
import { isReply, type SettingsPage, type View } from './types'

/*
 * What each card state accepts: which control gestures act, whether recognition feeds it signs,
 * which options fingers pick, and the lists Settings shows. Plain functions of the view, used by
 * the controller, the engines and the views.
 */

export type HoldPage = Extract<SettingsPage, { page: 'newGestureHold' }>

/** Hands-only control gestures produced by the gesture engine (Phase 3) or dev hotkeys. */
export type GestureName =
  | 'palmHold'
  | 'swipeLeft'
  | 'swipeRight'
  | 'swipeUp'
  | 'thumbsUp'
  | 'fist'
  | 'fingers'
  | 'handsDown'
  | 'shape'

export interface GestureInput {
  gesture: GestureName
  /** For 'fingers': 1..5. */
  count?: number
  /** For 'shape': the custom gesture id. */
  shapeId?: string
}

/** Mouse / trackpad taps on card controls map onto the same actions as gestures. */
export type TapTarget =
  | 'primary'
  | 'secondary'
  | 'close'
  | 'collapse'
  | 'expand'
  | 'camera'
  | 'proceed'
  | 'option'
  | 'settings'
  | 'captions'

export const QUICK_MENU = ['Create event', 'Send message', 'Search web', 'Take notes', 'Open app']
export const SETTINGS_ROOT = ['Teach a sign', 'New gesture', 'My gestures', 'Camera source', 'Sensitivity']

/** Gestures per page of My gestures (two-line rows). */
export const GESTURE_PAGE = 4
/** Teach a sign: the first option on every page of the list. */
export const SHOW_ME = 'Show me a sign'
/** Teach › Show me a sign: after the guesses, the list-based teaching. */
export const NONE_OF_THESE = 'None of these: pick from list'

/** Listening: a movement started in Ready and nothing is recognized yet. */
export function isListening(view: View): boolean {
  return view.kind === 'recognizing' && view.token === null
}

/** Command and Spell mode's views where a recognized sign joins (or starts) the phrase. */
export function collectsPhrase(view: View): boolean {
  return view.kind === 'ready' || view.kind === 'recognizing' || view.kind === 'building' || isReply(view)
}

/**
 * Where a guessed sign can start and land: the views that add a recognized sign to the phrase
 * (or type it, in Dictation), the agent's reply included. Not while the agent works on one.
 */
export function guessView(view: View): boolean {
  switch (view.kind) {
    case 'ready':
    case 'recognizing':
    case 'building':
    case 'dictation':
      return true
    case 'conversation':
      return view.phase === 'reply'
    default:
      return false
  }
}

/** Teach › Show me a sign, waiting for (or hearing) its one repetition. */
export function showsSign(view: View): boolean {
  if (view.kind !== 'settings' || view.settings.page !== 'teachShow') return false
  return view.settings.phase === 'waiting' || view.settings.phase === 'listening'
}

/** Which gestures make sense in each view (and mode). The gesture engine ignores the rest. */
export function activeGestures(view: View, mode: Mode = 'command'): Set<GestureName> {
  switch (view.kind) {
    case 'collapsed':
      return new Set(['palmHold', 'shape'])
    case 'ready':
      // The quick menu prefixes commands: Spell mode has none (and an ASL A is close to a thumbs up).
      if (mode === 'spell') return new Set(['fist', 'swipeLeft', 'swipeRight', 'swipeUp', 'shape'])
      return new Set(['thumbsUp', 'fist', 'swipeLeft', 'swipeRight', 'swipeUp', 'shape'])
    case 'recognizing':
      // Raising a hand to make a control gesture is a movement too: Listening keeps Ready's gestures.
      if (isListening(view)) return activeGestures({ kind: 'ready' }, mode)
      return new Set(['thumbsUp', 'fist', 'swipeLeft', 'swipeRight', 'handsDown'])
    case 'building':
      return new Set(['thumbsUp', 'fist', 'swipeLeft', 'swipeRight', 'handsDown'])
    case 'conversation':
      // The reply stays ready for the next message: Ready's gestures (thumbs up opens the result).
      if (view.phase === 'reply') return activeGestures({ kind: 'ready' }, mode)
      return new Set(['fist'])
    case 'working':
      return new Set(['fist'])
    case 'confirm':
      return new Set(['thumbsUp', 'fist'])
    case 'didYouMean':
      // A meeting time is picked by fingers only: a thumbs up would quietly mean 1 PM.
      if (view.purpose === 'meeting') return new Set(['fingers', 'fist'])
      // Swipe left edits what a spelling list was made from: the spelled letters.
      if (view.purpose === 'sign' || view.purpose === 'learn') return new Set(['fingers', 'fist', 'thumbsUp'])
      return new Set(['fingers', 'fist', 'thumbsUp', 'swipeLeft'])
    case 'quickMenu':
      return new Set(['fingers', 'fist'])
    case 'dictation':
      return new Set(['fist', 'swipeLeft', 'swipeRight', 'swipeUp'])
    case 'toast':
      // A screenshot's thumbnail: thumbs up opens it in Preview.
      return new Set(view.thumb && view.view ? ['thumbsUp', 'fist'] : ['fist'])
    case 'settings':
      switch (view.settings.page) {
        case 'teachSpell':
          return new Set(['thumbsUp', 'fist', 'swipeLeft'])
        case 'teachRecord':
          // Letters are held still and S, T, M, N read as a fist: a swipe goes back instead.
          return new Set([view.settings.kind === 'letter' ? 'swipeLeft' : 'fist'])
        case 'teachShow':
          // The sign itself may show fingers or a thumbs up: those pick only once there are guesses.
          return new Set(view.settings.phase === 'guess' ? ['fingers', 'thumbsUp', 'fist'] : ['fist'])
        case 'newGestureHold':
          // The new shape may read as a fist (or a thumbs up) while it is formed: until a recording
          // is refused, only a swipe goes back.
          return new Set(view.settings.reason ? ['thumbsUp', 'fist', 'swipeLeft'] : ['swipeLeft'])
        case 'camera':
          // Hands typing the URL can read as a fist or a finger count: while the field is open,
          // only a swipe closes it.
          return new Set(view.settings.editing ? ['swipeLeft'] : ['fingers', 'fist', 'swipeLeft', 'swipeRight'])
        default:
          return new Set(['fingers', 'fist', 'swipeLeft', 'swipeRight'])
      }
  }
}

/**
 * The screen a view counts as when a new one must not inherit a gesture already shown
 * (gestureInput spends them). Listening is still Ready, so a fist raised into view, which
 * starts a movement and shows Listening, can still collapse the card. A refused shape is
 * its own screen: the shape (a thumbs up, a fist) is often still held as the reason appears.
 */
export function gestureScreen(view: View): string {
  if (isListening(view)) return 'ready'
  if (view.kind === 'settings' && view.settings.page === 'newGestureHold') {
    return view.settings.reason ? 'shapeRefused' : 'shapeHold'
  }
  // The guesses come up while the hand may still hold the sign's last shape (two fingers, say).
  if (view.kind === 'settings' && view.settings.page === 'teachShow') return `teachShow:${view.settings.phase}`
  // The reply brings Ready's gestures: a thumbs up or fist already up while the agent worked must be made again.
  if (view.kind === 'conversation') return `conversation:${view.phase}`
  return view.kind
}

/** New gesture › hold is recording the shape (app/shapeInput feeds it the camera frames). */
export function isCapturingShape(view: View): view is { kind: 'settings'; settings: HoldPage } {
  return view.kind === 'settings' && view.settings.page === 'newGestureHold' && view.settings.countdown === 0 && !view.settings.reason
}

/** Views that take signs from recognition. Teach › record feeds its own recorder instead. */
export function takesSigns(view: View): boolean {
  switch (view.kind) {
    case 'ready':
    case 'recognizing':
    case 'building':
    case 'dictation':
      return true
    case 'conversation':
      // The reply: the next sign starts the next message.
      return view.phase === 'reply'
    case 'settings':
      return view.settings.page === 'teachSpell'
    default:
      return false
  }
}

/** Options listed (and numbered) in the current view, for finger-count picking. */
export function optionsFor(view: View): string[] {
  switch (view.kind) {
    case 'didYouMean':
      return view.options
    case 'quickMenu':
      return view.options
    case 'settings':
      return settingsOptions(view.settings)
    default:
      return []
  }
}

export const STARTER_WORDS = [
  'YES', 'NO', 'HELLO', 'MEETING', 'TOMORROW', 'TIME', 'NEXT', 'WHAT',
  'SEND', 'EMAIL', 'TEXT', 'FRIEND', 'PLAY', 'MUSIC', 'CALENDAR', 'GOOD'
]
export const LETTERS = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('')
/**
 * The teach list: the letters of contact nicknames that are initials (DW for Darren Wu: D, W)
 * first, since CALL D W and MEETING D W need those two taught, then the starter words and the rest
 * of the alphabet.
 */
export function teachLabels(aliases: Readonly<Record<string, string>> = getApp().contactAliases): string[] {
  const initials = Object.keys(aliases)
    .filter((word) => word.length <= 3 && [...word.toUpperCase()].every((l) => LETTERS.includes(l)))
    .flatMap((word) => [...word.toUpperCase()])
  const first = [...new Set(initials)]
  return [...first, ...STARTER_WORDS, ...LETTERS.filter((l) => !first.includes(l))]
}
/** Signs per page of the teach list: with Show me a sign and Spell a new word, five rows (fingers 1-5). */
export const TEACH_PAGE = 3

export function settingsOptions(page: SettingsPage): string[] {
  switch (page.page) {
    case 'root':
      return SETTINGS_ROOT
    case 'teachPick':
      return [SHOW_ME, ...teachLabels().slice(page.offset, page.offset + TEACH_PAGE), 'Spell a new word']
    case 'teachShow':
      return page.phase === 'guess' ? [...(page.guesses ?? []), NONE_OF_THESE] : []
    case 'newGesturePick':
      return [...page.tasks.slice(0, 4), 'Sign a new task']
    case 'gestures':
      return page.gestures.slice(page.offset, page.offset + GESTURE_PAGE).map((g) => g.name)
    case 'gestureDetail':
      return page.gesture.builtin ? ['Test it'] : ['Test it', 'Delete']
    case 'camera':
      return ['MacBook camera', 'ESP32-CAM stream', 'Edit stream URL']
    case 'sensitivity':
      return ['Low', 'Medium', 'High']
    default:
      return []
  }
}
