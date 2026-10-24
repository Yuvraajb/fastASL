import type { Mode, SignTemplate } from '@shared/types'
import { HOLD_MS } from '../engine/gestures/engine'
import { Segmenter } from '../engine/recognition/segmenter'
import { RecognitionSession, type RecognitionEvent } from '../engine/recognition/session'
import { TeachSession } from '../engine/recognition/teach'
import { SENSITIVITY, type FrameSample } from '../engine/types'
import { countSigns, takesSigns, type Controller, type GestureInput, type GestureName } from './controller'
import { live } from './live'
import { getApp, useApp, type AppState } from './store'
import type { SettingsPage, Token, View } from './types'

/** How long recognition ignores the camera after a control gesture fires. */
const GESTURE_SUSPEND_MS = 600
const SWIPES: ReadonlySet<GestureName> = new Set(['swipeLeft', 'swipeRight', 'swipeUp'])
/** A swipe whose movement is still being judged after this long (the hands kept moving) is dropped. */
const SWIPE_VERDICT_MS = 1500

type Target = Pick<
  Controller,
  | 'gesture'
  | 'signStart'
  | 'token'
  | 'ambiguousSign'
  | 'signRejected'
  | 'teachListening'
  | 'teachProgress'
  | 'teachLearned'
>
type TeachPage = Extract<SettingsPage, { page: 'teachRecord' }>

export interface RecognitionConnection {
  /**
   * One camera frame, after the gesture engine has seen it. True when the hand still holds the
   * shape of what it just signed, which is no control gesture: a recognized word's last
   * handshape, or a letter in letters-only mode (it comes with no wait, so a held S would
   * otherwise also fire the fist).
   */
  update(frame: FrameSample): boolean
  /** The gesture engine fired: arbitrates between the gesture and the sign in progress, then tells the controller. */
  gesture(input: GestureInput): void
  stop(): void
}

interface Teaching {
  label: string
  session: TeachSession
  /** Its own segmenter, so it can start blocked (see startTeaching). */
  segmenter: Segmenter
}

/**
 * Connects sign recognition to the app. Frames go to a RecognitionSession in the views that
 * take signs (takesSigns) and to a TeachSession on Teach › record; events go to the
 * controller. Recognition follows the store's templates, sensitivity and mode (Spell a new
 * word is letters only). Word labels are glosses (MEETING); their tokens are lower case,
 * the way sentences and typed text use them.
 */
export function connectRecognition(controller: Target): RecognitionConnection {
  const initial = getApp()
  // Outside Spell mode a letter waits out the longest control hold, so suspend() can drop it.
  const rec = new RecognitionSession({ controlHoldMs: Math.max(...Object.values(HOLD_MS)) })
  let hasWords = false
  const setTemplates = (templates: SignTemplate[]): void => {
    rec.setTemplates(templates)
    hasWords = templates.some((t) => t.kind === 'word')
    if (window.fastasl?.isDev) {
      console.log(`[signs] ${templates.length} template(s) for ${Object.keys(countSigns(templates)).length} sign(s)`)
    }
  }
  setTemplates(initial.templates)
  rec.setSensitivity(SENSITIVITY[initial.sensitivity])
  /** Spell mode or Spell a new word: letters only, each as soon as it is held. */
  let lettersOnly = recognitionMode(initial) === 'spell'
  rec.setMode(recognitionMode(initial))
  let teaching: Teaching | null = null
  /** Whether the previous frame went to `rec`; if not, its motion and holds are stale. */
  let fed = false
  let cameraSession: CanvasImageSource | null = null
  let lastT = 0
  /** A movement got signStart and no outcome yet. */
  let moving = false
  /** A swipe made by that movement, waiting for its verdict. */
  let heldSwipe: { input: GestureInput; t: number } | null = null
  const forgetMovement = (): void => {
    moving = false
    heldSwipe = null
  }
  /** The movement in progress gets no outcome (the camera went away or changed): don't leave Listening up. */
  const dropMovement = (): void => {
    if (moving) controller.signRejected()
    forgetMovement()
  }

  /** A control gesture acts: the sign or held-back letter it was made with is dropped. */
  const applyGesture = (input: GestureInput): void => {
    forgetMovement()
    rec.suspend(GESTURE_SUSPEND_MS)
    controller.gesture(input)
    // The dropped sign gets no outcome: don't leave Listening up.
    controller.signRejected()
  }

  /** A new recorder each time a Teach › record page opens; none elsewhere. */
  const followTeachPage = (view: View): void => {
    const page = teachPage(view)
    if (!page) teaching = null
    else if (teaching?.label !== page.label) teaching = startTeaching(page)
  }
  followTeachPage(initial.view)

  const stopStore = useApp.subscribe((s, prev) => {
    if (s.templates !== prev.templates) setTemplates(s.templates)
    if (s.sensitivity !== prev.sensitivity) rec.setSensitivity(SENSITIVITY[s.sensitivity])
    if (s.view !== prev.view || s.mode !== prev.mode) {
      const mode = recognitionMode(s)
      rec.setMode(mode)
      lettersOnly = mode === 'spell'
      // Spell mode drops the outcome of a movement in progress.
      if (lettersOnly) forgetMovement()
    }
    if (s.view !== prev.view) followTeachPage(s.view)
  })

  const route = (e: RecognitionEvent): void => {
    log(`[sign] ${describe(e)}`)
    if (e.type === 'signStart') {
      moving = true
      return controller.signStart()
    }
    if (e.type === 'rejected') {
      const swipe = heldSwipe
      forgetMovement()
      if (swipe && lastT - swipe.t <= SWIPE_VERDICT_MS) return applyGesture(swipe.input)
      return controller.signRejected()
    }
    if (e.kind === 'word') {
      if (heldSwipe) log(`[gesture] ${heldSwipe.input.gesture} dropped: the movement was a sign`)
      forgetMovement()
    }
    if (e.type === 'token') return controller.token(tokenFor(e.text, e.kind))
    // A close call between letters takes the best guess: asking for every letter would
    // stall fingerspelling, and the spelling suggestions fix the word at the end.
    if (e.kind === 'letter') return controller.token(tokenFor(e.options[0], 'letter'))
    controller.ambiguousSign(e.options.map((label) => tokenFor(label, 'word').text))
  }

  /** The recorder starts over (the camera went away or changed): a movement it was hearing ends Listening. */
  const restartTeaching = (t: Teaching): void => {
    t.segmenter.reset()
    if (!teachPage(getApp().view)?.listening) return
    const { done, reason } = t.session.progress
    controller.teachProgress(done, reason)
  }

  const teach = (t: Teaching, frame: FrameSample, aspect: number, newCamera: boolean): void => {
    t.segmenter.setAspect(aspect)
    if (newCamera) restartTeaching(t)
    for (const segment of t.segmenter.push(frame)) {
      const event = t.session.addSegment(segment)
      if (!event) continue
      if (event.type === 'listening') {
        log('[teach] listening')
        controller.teachListening()
        continue
      }
      const { done, total, reason } = event.progress
      log(`[teach] ${done}/${total}${reason ? ` (${reason})` : ''}`)
      controller.teachProgress(done, reason)
      // A complete session ignores further segments, so this runs once.
      if (t.session.complete) void controller.teachLearned(t.label, t.session.finish())
    }
  }

  return {
    update(frame) {
      lastT = frame.t
      // The feed shows the mock hand: not a real hand. The pipeline sends one such frame when
      // the camera goes away, which ends a movement in progress.
      if (live.mock) {
        fed = false
        dropMovement()
        if (teaching) restartTeaching(teaching)
        return false
      }
      const aspect = live.sourceWidth / live.sourceHeight
      const newCamera = live.source !== cameraSession
      cameraSession = live.source
      if (teaching || !takesSigns(getApp().view)) {
        fed = false
        forgetMovement()
        if (teaching) teach(teaching, frame, aspect, newCamera)
        return false
      }
      rec.setAspect(aspect)
      // Back from a view without signs, or a new camera session: no stale motion or holds.
      if (!fed || newCamera) {
        rec.suspend(0, frame.t)
        dropMovement()
      }
      fed = true
      const events = rec.update(frame)
      events.forEach(route)
      return events.some((e) => (e.type === 'token' || e.type === 'ambiguous') && (e.kind === 'word' || lettersOnly))
    },
    gesture(input) {
      // A swipe made while recognition judges a movement waits for the verdict: a recognized
      // word wins (MUSIC sweeps a flat hand sideways); otherwise the swipe acts once the
      // movement ends. Without word templates there is nothing to wait for.
      if (moving && hasWords && SWIPES.has(input.gesture)) {
        log(`[gesture] ${input.gesture} waits for the sign`)
        heldSwipe = { input, t: lastT }
        return
      }
      applyGesture(input)
    },
    stop: stopStore
  }
}

/** Dev diagnostics (FASTASL_LOG=1 prints them to stdout), with the view the event arrived in. */
function log(line: string): void {
  if (window.fastasl?.isDev) console.log(`${line} in ${getApp().view.kind}`)
}

function describe(e: RecognitionEvent): string {
  switch (e.type) {
    case 'signStart':
      return 'start'
    case 'token':
      return `${e.text} (${e.kind})`
    case 'ambiguous':
      return `${e.options.join(' or ')}? (${e.kind})`
    case 'rejected':
      return 'rejected'
  }
}

function teachPage(view: View): TeachPage | null {
  return view.kind === 'settings' && view.settings.page === 'teachRecord' ? view.settings : null
}

/** Spell a new word takes letters only, as soon as each is held (Spell mode). */
function recognitionMode(s: AppState): Mode {
  return s.view.kind === 'settings' && s.view.settings.page === 'teachSpell' ? 'spell' : s.mode
}

/**
 * The recorder starts blocked: the hand still up from the finger pick that opened the page
 * must change shape, slide or leave before a hold counts as a repetition.
 */
function startTeaching(page: TeachPage): Teaching {
  const segmenter = new Segmenter()
  segmenter.reset()
  return { label: page.label, session: new TeachSession(page.label, page.kind, page.total), segmenter }
}

function tokenFor(label: string, kind: Token['kind']): Token {
  return { text: kind === 'word' ? label.toLowerCase() : label, kind }
}
