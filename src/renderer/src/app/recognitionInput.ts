import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import type { Mode, SignTemplate } from '@shared/types'
import { pickFrames, type CapturedFrame } from '../engine/camera/frameRing'
import { HOLD_MS } from '../engine/gestures/engine'
import { slotPresent } from '../engine/recognition/features'
import { summarizeMotion } from '../engine/recognition/motionSummary'
import { Segmenter } from '../engine/recognition/segmenter'
import { RecognitionSession, type Movement, type RecognitionEvent } from '../engine/recognition/session'
import { STREAM_RULES } from '../engine/recognition/streamRules'
import { supersede } from '../engine/recognition/streamRules/supersede'
import { InitialsSpotter, INITIAL_SHAPES } from '../engine/recognition/initials'
import type { Classification } from '../engine/recognition/recognizer'
import { TEACH_REASONS, TeachSession } from '../engine/recognition/teach'
import { decide, describeTop, ISLR_MAX_RANK, withTaught, yieldToGesture, type FinalDecision, type TaughtDecision } from '../engine/model/decide'
import { dumpMovement } from '../engine/model/dump'
import type { ModelVerdict, MovementWindow, SignModel } from '../engine/model/signModel'
import { SENSITIVITY, type FrameSample } from '../engine/types'
import {
  countSigns,
  showsSign,
  takesSigns,
  type Controller,
  type GestureInput,
  type GestureName,
  type UnknownMovement
} from './controller'
import { live } from './live'
import { getApp, useApp, type AppState } from './store'
import type { SettingsPage, Token, View } from './types'

/** How long recognition ignores the camera after a control gesture fires. */
const GESTURE_SUSPEND_MS = 600
/**
 * "Listening..." shows only once a movement has lasted this long (camera frame time): a hand
 * settling, a twitch or the start of a gesture leaves the card as it is instead of flashing it.
 */
const LISTEN_DELAY_MS = 400
/** Once shown, "Listening..." stays at least this long, so a rejected movement doesn't make it flicker. */
const LISTEN_MIN_MS = 700
/** Held shapes that are signing, not commands, while both hands are in view (see gesture()). */
const TWO_HAND_SIGN_SHAPES: ReadonlySet<GestureName> = new Set(['fist', 'thumbsUp'])
const SWIPES: ReadonlySet<GestureName> = new Set(['swipeLeft', 'swipeRight', 'swipeUp'])
/** A swipe whose movement is still being judged after this long (the hands kept moving) is dropped. */
const SWIPE_VERDICT_MS = 1500
/** Guess, confirm, learn: a movement this long, start to end, can be a sign worth asking about. */
export const GUESS_MIN_MS = 400
export const GUESS_MAX_MS = 3000
/**
 * A guess waits this long (times the sensitivity's hold scale) after its movement ends: the
 * longest control hold plus a margin. A control gesture held with the movement's last shape (a
 * fist, a thumbs up, a finger count) fires within it, and a letter held with it arrives within
 * it; either one drops the guess, so the movement into a gesture or a letter is never sent.
 */
export const GUESS_WAIT_MS = Math.max(...Object.values(HOLD_MS)) + 250
/**
 * After a control gesture acts, a movement that starts within this long is its follow-through
 * (a swipe's return stroke, the hand coming down from a pick), never a guess.
 */
export const GUESS_AFTER_GESTURE_MS = 1500
/**
 * The pretrained model answers within a frame or two (~30 ms, ~250 ms with ASL Citizen). One
 * that hasn't answered after this long (camera-frame time) is ignored: the movement gets the
 * taught signs' outcome alone.
 */
export const MODEL_WAIT_MS = 1500
/** Camera frames kept for the model's context around a movement: the longest movement and then some. */
const HISTORY_MS = 6000

/**
 * Whether a movement nothing matched is worth a guess: clean (it neither started with the hands
 * coming into view nor ended with them leaving, so no raise or lowering) and of sign length.
 */
export function signLike(m: Pick<Movement, 'entered' | 'left' | 'durationMs'>): 'yes' | 'edge' | 'short' | 'long' {
  if (m.entered || m.left) return 'edge'
  if (m.durationMs < GUESS_MIN_MS) return 'short'
  if (m.durationMs > GUESS_MAX_MS) return 'long'
  return 'yes'
}

/** Words after which a contact's initials are spelled: CALL D W, MEETING D W. */
const NAMES_FOLLOW = /^(call|facetime|meeting)$/i

/**
 * The letters the initials spotter may give now: right after CALL / FACETIME / MEETING (and the
 * letters spelled since), the next letter of a nickname that is initials (dw -> D, then W), if
 * the spotter knows its shape. Command mode only; empty everywhere else.
 */
export function nextInitials(s: Pick<AppState, 'mode' | 'composing' | 'contactAliases'>): string[] {
  if (s.mode !== 'command') return []
  const tokens = s.composing.tokens
  let i = tokens.length - 1
  while (i >= 0 && tokens[i].kind === 'letter') i--
  if (i < 0 || !NAMES_FOLLOW.test(tokens[i].text)) return []
  const spelled = tokens.slice(i + 1).map((t) => t.text.toUpperCase()).join('')
  const next = Object.keys(s.contactAliases)
    .map((k) => k.toUpperCase())
    .filter((k) => k.length <= 3 && k.length > spelled.length && k.startsWith(spelled))
    .map((k) => k[spelled.length])
  return [...new Set(next)].filter((l) => INITIAL_SHAPES[l] !== undefined)
}

/** A recognition event as routed: a streamed word may replace the one before it (supersede). */
type Routed = RecognitionEvent | (Extract<RecognitionEvent, { type: 'token' }> & { replaces: string })

type Target = Pick<
  Controller,
  | 'gesture'
  | 'signStart'
  | 'token'
  | 'replaceLastToken'
  | 'ambiguousSign'
  | 'signRejected'
  | 'teachListening'
  | 'teachProgress'
  | 'teachLearned'
  | 'guessesSigns'
  | 'unknownSign'
  | 'showSignListening'
  | 'showSignEnded'
  | 'showSign'
>
type TeachPage = Extract<SettingsPage, { page: 'teachRecord' }>

export interface RecognitionOptions {
  /** The pretrained sign model once it has loaded; null before that, or when its files are missing. */
  model?: () => SignModel | null
  /**
   * Whether a hand holds a control gesture's shape that is timing toward firing (the gesture
   * engine's hold): a model word then needs GESTURE_OVERRIDE_P to take the movement.
   */
  holdingGesture?: () => boolean
}

/** A movement the pretrained model is looking at; its outcome waits for the answer. */
interface Judging {
  movement: Movement
  /** The taught signs' outcome (DTW), and the classification behind it. */
  local: RecognitionEvent
  dtw: Classification | null
  /** Frame time the movement was cut. */
  since: number
  verdict: ModelVerdict | 'failed' | null
}

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

/** Teach › Show me a sign, listening for its one repetition. */
interface Showing {
  segmenter: Segmenter
  /** The first frame it saw: movements that start within SHOW_SETTLE_MS of it are ignored. */
  since: number | null
  /** The movement in progress started within the settle time: its outcome is ignored too. */
  settling: boolean
}

/**
 * Show me a sign ignores movements that start this soon after it begins listening: the hand
 * coming down from the finger pick that opened the page (or getting ready after a failed try)
 * is no sign, and asking the LLM about it would block the real one.
 */
export const SHOW_SETTLE_MS = 1000

/**
 * Connects sign recognition to the app. Frames go to a RecognitionSession in the views that
 * take signs (takesSigns) and to a TeachSession on Teach › record; events go to the
 * controller. Recognition follows the store's templates, sensitivity and mode (Spell a new
 * word is letters only). Word labels are glosses (MEETING); their tokens are lower case,
 * the way sentences and typed text use them.
 */
export function connectRecognition(
  controller: Target,
  /** The camera frames engines.ts keeps for guesses (none unless a guess could use them). */
  recentFrames: () => readonly CapturedFrame[] = () => [],
  options: RecognitionOptions = {}
): RecognitionConnection {
  const signModel = options.model ?? (() => null)
  const initial = getApp()
  // Outside Spell mode a letter waits out the longest control hold, so suspend() can drop it.
  // Streaming signs (the dictionary, then the stream rules) come first, on every frame.
  const rec = new RecognitionSession({
    controlHoldMs: Math.max(...Object.values(HOLD_MS)),
    dictionary: DEFAULT_DICTIONARY,
    streamRules: STREAM_RULES
  })
  // A control gesture's hold in progress (a thumbs up, a fist, a shape held still) is no sign.
  rec.setStreamGate(() => !options.holdingGesture?.())
  if (window.fastasl?.isDev) {
    console.log(`[lexicon] ${rec.lexiconSize} streaming sign(s) loaded (${initial.mode} mode${initial.mode === 'spell' ? ': off, Spell mode is letters only' : ''})`)
  }
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
  let showing: Showing | null = null
  /** Whether the previous frame went to `rec`; if not, its motion and holds are stale. */
  let fed = false
  let cameraSession: CanvasImageSource | null = null
  let lastT = 0
  /** Hands in the latest frame (see gesture()). */
  let handsInView = 0
  /** The camera's aspect at the last frame, for the motion summary of a movement routed from it. */
  let aspectNow = 1
  /** A movement got signStart and no outcome yet. */
  let moving = false
  /**
   * A control gesture waiting for that movement's verdict: a swipe the movement made, or any
   * gesture that fired while the sign model was still judging it.
   */
  let heldGesture: { input: GestureInput; t: number } | null = null
  /** A movement to guess once GUESS_WAIT_MS has passed with no gesture, sign or letter. */
  let pendingGuess: { movement: UnknownMovement; at: number } | null = null
  /** When a control gesture last acted (frame time). */
  let lastGestureT = -Infinity
  /** The pretrained model is judging the last movement: its outcome is held until the answer. */
  let judging: Judging | null = null
  /** Recent tracked frames (hands, face, pose): the model's context around a movement. */
  const history: FrameSample[] = []
  /** Streaming words that came while the model was judging an earlier movement: they follow its word. */
  let queued: Routed[] = []
  const initials = new InitialsSpotter()
  /** The last streamed word and its frame time (see supersede: FRIEND over TIME). */
  let lastStreamed: { word: string; t: number } | null = null
  /** Dev: when the streaming matcher's state was last logged. */
  let lastDbg = -Infinity
  const forgetMovement = (): void => {
    moving = false
    heldGesture = null
    judging = null
  }

  // "Listening..." on the card, debounced by frame time (LISTEN_DELAY_MS, LISTEN_MIN_MS).
  /** A movement started and Listening isn't up yet: when (frame time). */
  let movingSince: number | null = null
  /** When Listening went up (controller.signStart); null while it isn't. */
  let listeningSince: number | null = null
  /** The movement got no outcome while Listening was up for less than LISTEN_MIN_MS: hide it later. */
  let hidePending = false
  const listenStart = (t: number): void => {
    // A new movement while Listening is still up keeps it up.
    if (listeningSince !== null) hidePending = false
    else movingSince = t
  }
  const listenTick = (t: number): void => {
    if (movingSince !== null && t - movingSince >= LISTEN_DELAY_MS) {
      movingSince = null
      listeningSince = t
      controller.signStart()
    }
    if (hidePending && listeningSince !== null && t - listeningSince >= LISTEN_MIN_MS) listenEnd()
  }
  /** The movement got no outcome: Listening goes (now, or once it has been up LISTEN_MIN_MS). */
  const listenRejected = (): void => {
    movingSince = null
    if (listeningSince !== null && lastT - listeningSince < LISTEN_MIN_MS) {
      hidePending = true
      return
    }
    listenEnd()
  }
  /** Listening goes now (a gesture acted, the camera went away). */
  const listenEnd = (): void => {
    movingSince = null
    listeningSince = null
    hidePending = false
    controller.signRejected()
  }
  /** A sign or letter replaced Listening, or recognition stopped listening here. */
  const listenForget = (): void => {
    movingSince = null
    listeningSince = null
    hidePending = false
  }

  /** The movement in progress gets no outcome (the camera went away or changed): don't leave Listening up. */
  const dropMovement = (): void => {
    if (moving || listeningSince !== null) listenEnd()
    else listenForget()
    forgetMovement()
  }

  /** A control gesture acts: the sign or held-back letter it was made with is dropped. */
  const applyGesture = (input: GestureInput): void => {
    // The movement into the gesture is no sign to guess. (Hands down only ends the phrase.)
    if (input.gesture !== 'handsDown') {
      if (pendingGuess) log(`[sign] guess dropped: ${input.gesture}`)
      pendingGuess = null
      lastGestureT = lastT
    }
    forgetMovement()
    rec.suspend(GESTURE_SUSPEND_MS)
    controller.gesture(input)
    // The dropped sign gets no outcome: don't leave Listening up.
    listenEnd()
  }

  /**
   * A new recorder each time a Teach › record page opens, and each time Show me a sign starts
   * waiting for a repetition; none elsewhere.
   */
  const followTeachPage = (view: View): void => {
    const page = teachPage(view)
    if (!page) teaching = null
    else if (teaching?.label !== page.label) teaching = startTeaching(page)
    showing = showsSign(view) ? (showing ?? startShowing()) : null
  }
  followTeachPage(initial.view)

  /** What a guess needs: the frames around the movement, what hand tracking measured, its vectors. */
  const unknownMovement = (m: Movement, aspect: number): UnknownMovement => {
    const start = m.frames[0].t
    const end = m.frames[m.frames.length - 1].t
    return {
      frames: pickFrames(recentFrames(), start, end).map((f) => f.jpeg),
      motion: summarizeMotion(m.frames, aspect, m.durationMs),
      features: m.features
    }
  }

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

  const route = (e: Routed, rejectedMovement: Movement | null = null): void => {
    log(`[sign] ${describe(e)}`)
    if (e.type === 'signStart') {
      moving = true
      return listenStart(lastT)
    }
    if (e.type === 'rejected') {
      const held = heldGesture
      forgetMovement()
      // A movement that made a swipe (or ended in a held gesture) is the gesture's (or, judged too
      // late, nobody's): never a guess.
      if (held) return lastT - held.t <= SWIPE_VERDICT_MS ? applyGesture(held.input) : listenRejected()
      // A whole, clean movement of sign length that nothing taught matched: maybe the LLM knows
      // it, once a control gesture or letter made with its last shape has had time to act.
      const movement = rejectedMovement
      const afterGesture = movement !== null && movement.frames[0].t < lastGestureT + GUESS_AFTER_GESTURE_MS
      if (movement && signLike(movement) === 'yes' && !afterGesture && controller.guessesSigns()) {
        const wait = GUESS_WAIT_MS * SENSITIVITY[getApp().sensitivity].holdScale
        log(`[sign] unknown movement, ${Math.round(movement.durationMs)} ms: asking the LLM in ${Math.round(wait)} ms`)
        pendingGuess = { movement: unknownMovement(movement, aspectNow), at: lastT + wait }
      }
      return listenRejected()
    }
    // A sign or a letter arrived: the movement before it was not the one to ask about.
    if (pendingGuess) log(`[sign] guess dropped: ${e.type === 'token' ? e.text : 'a sign'} came first`)
    pendingGuess = null
    if (e.kind === 'word') {
      if (heldGesture) log(`[gesture] ${heldGesture.input.gesture} dropped: the movement was a sign`)
      forgetMovement()
      listenForget()
    }
    if (e.type === 'token') {
      const token = tokenFor(e.text, e.kind)
      return 'replaces' in e && e.replaces ? controller.replaceLastToken(e.replaces, token) : controller.token(token)
    }
    // A close call between letters takes the best guess: asking for every letter would
    // stall fingerspelling, and the spelling suggestions fix the word at the end.
    if (e.kind === 'letter') return controller.token(tokenFor(e.options[0], 'letter'))
    controller.ambiguousSign(e.options.map((label) => tokenFor(label, 'word').text))
  }

  /** The movement and the frames around it, from the history (just its own frames if they have left it). */
  const windowFor = (m: Movement): MovementWindow => {
    const start = history.indexOf(m.frames[0])
    const end = history.indexOf(m.frames[m.frames.length - 1])
    return start >= 0 && end >= start ? { frames: history.slice(), start, end } : { frames: m.frames, start: 0, end: m.frames.length - 1 }
  }

  /** A movement's taught-sign outcome waits while the model looks at it (see resolveJudging). */
  const judge = (model: SignModel, movement: Movement, local: RecognitionEvent, dtw: Classification | null): void => {
    // A movement still waiting (one can only follow another within MODEL_WAIT_MS) gets its own outcome now.
    if (judging) resolveJudging(judging.verdict === null)
    const j: Judging = { movement, local, dtw, since: lastT, verdict: null }
    judging = j
    const win = windowFor(movement)
    // Dev calibration: the movement's points, to replay live signing offline through both models.
    if (window.fastasl?.isDev) console.log(`[model-dump] ${dumpMovement(win)}`)
    model.classify(win).then(
      (verdict) => {
        if (judging === j) j.verdict = verdict
      },
      (err: unknown) => {
        log(`[model] failed: ${err instanceof Error ? err.message : String(err)}`)
        if (judging === j) j.verdict = 'failed'
      }
    )
  }

  /** The taught signs' outcome for the movement, in the model's terms. */
  const taughtDecision = (local: RecognitionEvent, dtw: Classification | null): TaughtDecision => {
    if (local.type === 'token' && dtw?.label) {
      const radius = rec.recognizer.wordRadius(dtw.label) * SENSITIVITY[getApp().sensitivity].acceptScale
      return { status: 'accepted', label: dtw.label, distance: dtw.distance, radius }
    }
    if (local.type === 'ambiguous') return { status: 'ambiguous', options: local.options }
    return { status: 'rejected' }
  }

  /**
   * The model answered (or ran out of time): the movement's outcome is decided and routed. Model
   * first, then the taught signs; a swipe the movement made, or a control hold the hand is in,
   * keeps the movement unless the model is very sure. Returns whether a word came of it.
   */
  const resolveJudging = (timedOut = false): boolean => {
    const j = judging
    if (!j) return false
    judging = null
    const verdict = j.verdict === 'failed' || j.verdict === null ? null : j.verdict
    if (verdict) logVerdict(verdict)
    else log(`[model] ${timedOut ? 'no answer in time' : 'failed'}: the taught signs decide`)
    let model = verdict?.decision ?? { status: 'rejected' as const }
    const gesture = heldGesture ? heldGesture.input.gesture : options.holdingGesture?.() ? 'a held gesture' : null
    if (gesture && model.status !== 'rejected') {
      const kept = yieldToGesture(model)
      if (kept.status === 'rejected') log(`[model] left to ${gesture}: ${describeDecision(model)} is not sure enough`)
      model = kept
    }
    const final = withTaught(model, taughtDecision(j.local, j.dtw))
    const event = eventFor(final)
    if (event.type !== 'rejected') rec.wordShown()
    route(event, event.type === 'rejected' ? j.movement : null)
    return event.type !== 'rejected'
  }

  /** The recorder starts over (the camera went away or changed): a movement it was hearing ends Listening. */
  const restartTeaching = (t: Teaching): void => {
    t.segmenter.reset()
    if (!teachPage(getApp().view)?.listening) return
    const { done, reason } = t.session.progress
    controller.teachProgress(done, reason)
  }

  /** Show me a sign: a raise or lowering of the hands, or a too-short movement, just ends Listening. */
  const show = (sh: Showing, frame: FrameSample, aspect: number, newCamera: boolean): void => {
    sh.segmenter.setAspect(aspect)
    if (newCamera) {
      sh.segmenter.reset()
      controller.showSignEnded()
    }
    sh.since ??= frame.t
    for (const segment of sh.segmenter.push(frame)) {
      if (segment.kind === 'start') {
        // Decided once per movement, at its start: every start gets exactly one outcome.
        sh.settling = segment.t < (sh.since ?? segment.t) + SHOW_SETTLE_MS
        if (!sh.settling) controller.showSignListening()
      } else if (segment.kind === 'cancel') {
        controller.showSignEnded(segment.reason === 'too-long' && !sh.settling ? TEACH_REASONS.tooLong : undefined)
      } else if (segment.kind === 'dynamic') {
        if (sh.settling) {
          controller.showSignEnded()
          continue
        }
        const verdict = signLike(segment)
        log(`[teach] shown movement ${Math.round(segment.durationMs)} ms: ${verdict}`)
        if (verdict !== 'yes') {
          controller.showSignEnded(verdict === 'long' ? TEACH_REASONS.tooLong : undefined)
          continue
        }
        const movement = unknownMovement(segment, aspect)
        const model = signModel()
        if (!model) {
          controller.showSign(movement)
          continue
        }
        // The pretrained model names it at once when it can; otherwise the LLM is asked.
        model.classify(windowFor(segment)).then(
          (v) => {
            logVerdict(v)
            const d = v.decision
            const named = d.status === 'accepted' ? [d.word] : d.status === 'ambiguous' ? d.options : []
            if (showing === sh) controller.showSign(movement, named.map((w) => w.toUpperCase()))
          },
          () => {
            if (showing === sh) controller.showSign(movement)
          }
        )
      }
    }
  }

  const teach = (t: Teaching, frame: FrameSample, aspect: number, newCamera: boolean): void => {
    t.segmenter.setAspect(aspect)
    if (newCamera) restartTeaching(t)
    for (const segment of t.segmenter.push(frame)) {
      if (segment.kind === 'cancel') log(`[teach-dbg] cancel ${segment.reason} entered=${segment.entered} left=${segment.left}`)
      const event = t.session.addSegment(segment)
      if (segment.kind === 'dynamic' && window.fastasl?.isDev) {
        const f = segment.features
        const share = (slot: number): string => `${Math.round((100 * f.filter((v) => slotPresent(v, slot)).length) / f.length)}%`
        log(
          `[teach-dbg] dynamic ${f.length} frames ${Math.round(segment.durationMs)}ms entered=${segment.entered} left=${segment.left} ` +
            `right=${share(0)} left=${share(1)} distances=[${t.session.latestDistances.map((d) => d.toFixed(2)).join(' ')}] match<=${t.session.matchDistance}`
        )
      }
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
      handsInView = frame.hands.length
      if (!live.mock) {
        history.push(frame)
        while (history.length && history[0].t < frame.t - HISTORY_MS) history.shift()
      }
      // The feed shows the mock hand: not a real hand. The pipeline sends one such frame when
      // the camera goes away, which ends a movement in progress.
      if (live.mock) {
        fed = false
        pendingGuess = null
        dropMovement()
        if (teaching) restartTeaching(teaching)
        if (showing) {
          showing.segmenter.reset()
          controller.showSignEnded()
        }
        return false
      }
      const aspect = live.sourceWidth / live.sourceHeight
      aspectNow = aspect
      const newCamera = live.source !== cameraSession
      cameraSession = live.source
      if (teaching || showing || !takesSigns(getApp().view)) {
        fed = false
        pendingGuess = null
        forgetMovement()
        listenForget()
        if (teaching) teach(teaching, frame, aspect, newCamera)
        if (showing) show(showing, frame, aspect, newCamera)
        return false
      }
      rec.setAspect(aspect)
      // Back from a view without signs, or a new camera session: no stale motion or holds.
      if (!fed || newCamera) {
        rec.suspend(0, frame.t)
        dropMovement()
      }
      fed = true
      // The model's answer about an earlier movement comes first, in frame order.
      let shown = false
      if (judging && (judging.verdict !== null || frame.t - judging.since > MODEL_WAIT_MS)) shown = resolveJudging(judging.verdict === null)
      if (!judging && queued.length) {
        for (const e of queued) route(e)
        queued = []
        shown = true
      }
      const events = rec.update(frame)
      if (window.fastasl?.isDev && frame.hands.length > 0 && frame.t - lastDbg > 200) {
        lastDbg = frame.t
        log(`[hello-dbg] ${lettersOnly ? 'off: Spell mode is letters only (swipe right for Command mode)' : rec.lexiconDebug}`)
      }
      const dtw = rec.lastWord
      if (rec.lastWord && window.fastasl?.isDev) {
        const { status, distance, alternatives } = rec.lastWord
        const best = alternatives[0]
        log(`[sign-dbg] ${status}: nearest ${best ?? '(none taught)'} at ${distance.toFixed(2)}${best ? ` (accepts <= ${rec.recognizer.wordRadius(best).toFixed(2)})` : ''}`)
        rec.lastWord = null
      }
      const model = signModel()
      for (const e of events) {
        if (e.type === 'token' && e.streamed) {
          // A streaming sign, mid-movement: its movement gets no outcome (the session settles it),
          // so no model word or guess for it. It waits only for an earlier movement's verdict.
          const verdict = supersede(lastStreamed, e.text, frame.t)
          if (verdict === 'drop') {
            log(`[stream] ${e.text} dropped: still ${lastStreamed?.word}'s movement`)
            continue
          }
          const routed: Routed = verdict === 'replace' && lastStreamed ? { ...e, replaces: lastStreamed.word } : e
          log(`[stream] ${e.text}${verdict === 'replace' ? ` (replaces ${lastStreamed?.word})` : ''}`)
          lastStreamed = { word: e.text, t: frame.t }
          if (judging) queued.push(routed)
          else {
            route(routed)
            shown = true
          }
          continue
        }
        // A movement's outcome (rec.lastMovement is set only then) waits for the model, if loaded.
        if (model && rec.lastMovement && e.type !== 'signStart' && (e.type === 'rejected' || e.kind === 'word')) {
          judge(model, rec.lastMovement, e, dtw)
          continue
        }
        route(e, e.type === 'rejected' ? rec.rejectedMovement : null)
        if ((e.type === 'token' || e.type === 'ambiguous') && (e.kind === 'word' || lettersOnly)) shown = true
      }
      // Untaught initials (D, W) for a contact nickname, right after CALL / MEETING (initials.ts).
      const next = nextInitials(getApp())
      const letter = next.length ? initials.update(frame, aspect, next) : (initials.reset(), null)
      if (letter) {
        log(`[initials] ${letter}`)
        route({ type: 'token', text: letter, kind: 'letter' })
        shown = true
      }
      listenTick(frame.t)
      if (pendingGuess && frame.t >= pendingGuess.at) {
        const { movement } = pendingGuess
        pendingGuess = null
        if (controller.guessesSigns()) controller.unknownSign(movement)
      }
      return shown
    },
    gesture(input) {
      // Two hands in view while signing: a held fist or thumbs up is part of a sign (TIME's base
      // hand is a fist held while the forearm is placed), not a command. Live, that fist cancelled
      // "tomorrow meeting what" just before TIME. One hand alone still cancels or sends.
      if (handsInView >= 2 && TWO_HAND_SIGN_SHAPES.has(input.gesture) && takesSigns(getApp().view)) {
        log(`[gesture] ${input.gesture} ignored: two hands in view (signing)`)
        return
      }
      // A swipe made while recognition judges a movement waits for the verdict: a recognized
      // word wins (MUSIC sweeps a flat hand sideways); otherwise the swipe acts once the
      // movement ends. Without word templates, the sign model or a dictionary sign's start in
      // view (signPending) there is nothing to wait for. A streaming word during that movement
      // drops the swipe.
      if (moving && (hasWords || signModel() !== null || rec.signPending) && SWIPES.has(input.gesture)) {
        log(`[gesture] ${input.gesture} waits for the sign`)
        heldGesture = { input, t: lastT }
        return
      }
      // The movement has ended but the sign model is still looking at it (up to ~0.4 s with ASL
      // Citizen): a gesture held with its last shape (TOMORROW's thumbs-up) waits for the verdict
      // too, so a sure word still wins and anything else lets the gesture act.
      if (judging && input.gesture !== 'handsDown') {
        log(`[gesture] ${input.gesture} waits for the sign model`)
        heldGesture = { input, t: lastT }
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

/** The decided outcome as a recognition event (model words are display words, taught ones glosses). */
function eventFor(d: FinalDecision): RecognitionEvent {
  if (d.status === 'accepted') return { type: 'token', text: d.word, kind: 'word' }
  if (d.status === 'ambiguous') return { type: 'ambiguous', options: d.options, kind: 'word' }
  return { type: 'rejected' }
}

function describeDecision(d: { status: string; word?: string; p?: number; options?: string[] }): string {
  if (d.status === 'accepted') return `${d.word} ${d.p?.toFixed(2)}`
  if (d.status === 'ambiguous') return `${d.options?.join(' or ')}?`
  return 'nothing'
}

/**
 * Dev: `[model] hello 0.93 · bye 0.04 · yes 0.01 (24 ms, face, 41 frames) -> hello 0.93`, each
 * model's top 3 among the enabled words and what it decided on its own; ASL Citizen's line
 * (`[model:citizen]`) only when it ran.
 */
function logVerdict(v: ModelVerdict): void {
  if (!window.fastasl?.isDev) return
  if (v.islr) {
    const flags = [`${Math.round(v.islr.ms)} ms`, v.face ? 'face' : 'no face', v.islr.swapped ? 'hands swapped' : null, `${v.frames} frames`, rankOf(v.islr)]
    log(`[model] ${describeTop(v.islr.ranked)} (${flags.filter(Boolean).join(', ')}) -> ${describeDecision(decide(v.islr.ranked, ISLR_MAX_RANK))}`)
  }
  if (v.citizen) {
    const flags = [`${Math.round(v.citizen.ms)} ms`, v.citizen.swapped ? 'hands swapped' : null, rankOf(v.citizen)]
    const own = v.decision.source === 'citizen' ? describeDecision(v.decision) : 'nothing'
    log(`[model:citizen] ${describeTop(v.citizen.ranked)} (${flags.filter(Boolean).join(', ')}) -> ${own}`)
  }
}

/** The top word's rank among all the model's signs, when it isn't first (the open-set check, decide.ts). */
function rankOf(run: { ranked: readonly { rank: number }[] }): string | null {
  const rank = run.ranked[0]?.rank ?? 0
  return rank > 0 ? `#${rank + 1} of all signs` : null
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

/** Show me a sign's recorder starts blocked too: the finger pick that opened the page is no repetition. */
function startShowing(): Showing {
  const segmenter = new Segmenter()
  segmenter.reset()
  return { segmenter, since: null, settling: false }
}

function tokenFor(label: string, kind: Token['kind']): Token {
  return { text: kind === 'word' ? label.toLowerCase() : label, kind }
}
