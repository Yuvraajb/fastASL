import { useLayoutEffect, useRef, useState } from 'react'
import {
  Calendar,
  Camera,
  CameraOff,
  Captions,
  CaptionsOff,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Hand,
  HandFist,
  Mail,
  MessageSquare,
  ThumbsUp,
  type LucideIcon
} from 'lucide-react'
import type { AgentStep, ConfirmDetails, ViewAction } from '@shared/types'
import { controller, llmBadge } from '../app/context'
import { imagePath, takesSigns } from '../app/controller'
import { useApp } from '../app/store'
import type { ChatCardView, ChatMessage, Composing, Token } from '../app/types'
import { CheckBadge, Feed, Header, Hint, IconButton, Notice, Spinner, Stack, type HintItem } from '../ui'
import './ChatView.css'

/** The camera strip: wide enough to see both hands sign, short enough to leave the chat room. */
const FEED_ASPECT = 16 / 9
/** Rows in the live steps bubble: the latest finished steps and the one running. */
const STEP_ROWS = 3
const STARTING: AgentStep = { id: 'starting', label: 'Starting agent', status: 'current' }

type Props = { view: ChatCardView }

/**
 * Command mode's one card: the camera, the chat transcript under it, and a slim footer with the
 * gestures that work now. Ready, the message being signed, the agent at work, its inline Confirm
 * and its reply are phases of this card, so it never swaps layouts while you talk to the agent.
 */
export function ChatView({ view }: Props): React.JSX.Element {
  const chat = useApp((s) => s.chat)
  const composing = useApp((s) => s.composing)
  const signing = useApp((s) => s.signing)
  const takes = takesSigns(view)
  // Listening: a movement is being judged (the header says so), or the last word was deleted.
  const listening = takes && (signing || (view.kind === 'recognizing' && view.token === null))
  const busy = view.kind === 'confirm' || (view.kind === 'conversation' && view.phase !== 'reply')
  const hint = view.kind === 'ready' ? view.hint : undefined
  return (
    <Stack className="chatcard">
      <Header view={view} close={busy} />
      <div className="chatcard__feed">
        <Feed aspect={FEED_ASPECT} brackets={takes} />
        {llmBadge ? (
          <span className="chatcard__llm" aria-hidden>
            {llmBadge}
          </span>
        ) : null}
      </div>
      <Transcript chat={chat} composer={takes ? { composing, listening, hint } : null} />
      <Notice />
      <ChatFooter items={hintFor(view)} />
    </Stack>
  )
}

interface Composer {
  composing: Composing
  listening: boolean
  /** Ready's hint: a quick-menu pick waiting for its details, a gesture's task. */
  hint?: string
}

/**
 * The messages, then the composing bubble while the card takes signs. It keeps the newest in view
 * (unless you scrolled up to read), and older messages fade out under the camera when it scrolls.
 */
function Transcript({ chat, composer }: { chat: ChatMessage[]; composer: Composer | null }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [clipped, setClipped] = useState(false)

  // Content or box size changed (a message, a word, a notice): back to the bottom, before paint.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const pin = (): void => {
      if (stick.current) el.scrollTop = el.scrollHeight
      setClipped(el.scrollTop > 1)
    }
    pin()
    const ro = new ResizeObserver(pin)
    ro.observe(el)
    if (list.current) ro.observe(list.current)
    return () => ro.disconnect()
  }, [])

  // Sending always shows the exchange, even after scrolling up.
  const last = chat.at(-1)
  useLayoutEffect(() => {
    if (last?.from !== 'you') return
    stick.current = true
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [last])

  const onScroll = (): void => {
    const el = box.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setClipped(el.scrollTop > 1)
  }

  const words = composer ? composedWords(composer.composing.tokens) : []
  const showComposer = composer !== null && (words.length > 0 || composer.listening || chat.length > 0)
  const empty = !chat.length && !showComposer
  return (
    <div ref={box} className={`chat${clipped ? ' chat--clipped' : ''}`} onScroll={onScroll} aria-live="polite">
      <div ref={list} className={`chat__list${empty ? ' chat__list--empty' : ''}`}>
        {empty ? (
          <div className="chat__empty">
            <Hand size={18} strokeWidth={1.8} aria-hidden />
            <p className="chat__empty-title">{composer?.hint ?? 'Sign to start'}</p>
            <p className="chat__empty-sub">hands down to send</p>
          </div>
        ) : null}
        {chat.map((m, i) => (
          <Message key={m.id} m={m} first={startsGroup(chat[i - 1], m.from)} />
        ))}
        {showComposer && composer ? (
          <ComposingBubble
            composer={composer}
            words={words}
            placeholder={composer.hint ?? 'Sign your next message'}
            first={startsGroup(last, 'you')}
          />
        ) : null}
      </div>
    </div>
  )
}

/** A new speaker (or the first bubble after a note) gets a little more room, and the agent its label. */
function startsGroup(prev: ChatMessage | undefined, from: ChatMessage['from']): boolean {
  return !prev || prev.kind === 'note' || prev.from !== from
}

/** Consecutive fingerspelled letters read as one word ("K R I S" -> "KRIS"), as on the Building card. */
function composedWords(tokens: readonly Token[]): string[] {
  const words: string[] = []
  let spelled = ''
  for (const t of tokens) {
    if (t.kind === 'letter') {
      spelled += t.text
      continue
    }
    if (spelled) words.push(spelled)
    spelled = ''
    words.push(t.text)
  }
  if (spelled) words.push(spelled)
  return words
}

function Message({ m, first }: { m: ChatMessage; first: boolean }): React.JSX.Element {
  if (m.kind === 'note') {
    return (
      <p className="chat__note" role="status">
        <span>{m.text}</span>
      </p>
    )
  }
  const label = m.from === 'agent' ? (first ? 'Agent' : null) : (m.prefix ?? null)
  return (
    <div className={`chat__row chat__row--${m.from}${first ? ' chat__row--first' : ''}`}>
      {label ? <span className="chat__who">{label}</span> : null}
      <Bubble m={m} />
    </div>
  )
}

function Bubble({ m }: { m: Exclude<ChatMessage, { kind: 'note' }> }): React.JSX.Element {
  switch (m.kind) {
    case 'text':
      return <p className={`bubble bubble--${m.from}`}>{m.text}</p>
    case 'steps':
      return (
        <div className="bubble bubble--agent bubble--steps" role="status">
          {shownSteps(m.steps).map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>
      )
    case 'result':
      return <ResultBubble id={m.id} answer={m.answer} />
    case 'error':
      return (
        <div className="bubble bubble--agent bubble--error" role="alert">
          <CircleAlert className="err__icon" size={16} strokeWidth={2} aria-hidden />
          <div className="err__body">
            <p className="err__title">{m.title}</p>
            {m.subtitle ? <p className="err__sub">{m.subtitle}</p> : null}
          </div>
        </div>
      )
    case 'confirm':
      return <ConfirmBubble m={m} />
  }
}

/** The steps up to the one running (or all of them), the last few: the latest work, never what's planned next. */
function shownSteps(steps: readonly AgentStep[]): AgentStep[] {
  if (!steps.length) return [STARTING]
  const current = steps.findLastIndex((s) => s.status === 'current')
  const upTo = current === -1 ? steps.length : current + 1
  return steps.slice(Math.max(0, upTo - STEP_ROWS), upTo)
}

function StepRow({ step }: { step: AgentStep }): React.JSX.Element {
  const running = step.status === 'current'
  return (
    <span className={`step step--${step.status}`}>
      {running ? <Spinner size={13} /> : <StepMark status={step.status} />}
      <span className="step__label">{running && !/[.…]$/.test(step.label) ? `${step.label}…` : step.label}</span>
    </span>
  )
}

function StepMark({ status }: { status: AgentStep['status'] }): React.JSX.Element {
  if (status === 'done') {
    return (
      <svg className="step__mark" width="13" height="13" viewBox="0 0 16 16" aria-label="Done">
        <circle cx="8" cy="8" r="8" fill="rgba(255,255,255,0.85)" />
        <path d="M4.6 8.2l2.2 2.2 4.6-4.7" fill="none" stroke="#0b0b0c" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg className="step__mark" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-label="Failed">
        <circle cx="8" cy="8" r="7.25" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
        <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg className="step__mark" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-label="Pending">
      <circle cx="8" cy="8" r="7.25" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" />
    </svg>
  )
}

/** What the agent did: a check badge (an X when it fell short) or the screenshot, the tools' title and subtitle, its own line. */
function ResultBubble({ id, answer }: { id: string; answer: Extract<ChatMessage, { kind: 'result' }>['answer'] }): React.JSX.Element {
  const thumb = answer.thumb
  return (
    <div className={`bubble bubble--agent bubble--result${thumb ? ' bubble--shot' : ''}`} role="status">
      <div className="res">
        {thumb ? (
          <button type="button" className="res__thumb" title="Open in Preview" onClick={() => controller.openChatResult(id)}>
            <img src={thumb} alt="Screenshot" draggable={false} />
          </button>
        ) : (
          <CheckBadge ok={answer.ok} size={22} />
        )}
        <div className="res__body">
          <p className="res__title">{answer.title}</p>
          {answer.subtitle ? (
            <p className={`res__sub${thumb ? ' res__sub--file' : ''}`} title={answer.subtitle}>
              {answer.subtitle}
            </p>
          ) : null}
        </div>
      </div>
      {answer.text ? <p className={`res__note${thumb ? '' : ' res__note--indent'}`}>{answer.text}</p> : null}
    </div>
  )
}

const CONFIRM_ICONS: Record<ConfirmDetails['kind'], LucideIcon> = {
  event: Calendar,
  mail: Mail,
  message: MessageSquare,
  generic: FileText
}

const CONFIRM_ASK: Record<ConfirmDetails['kind'], string> = {
  event: 'Create this event?',
  mail: 'Send this email?',
  message: 'Send this message?',
  generic: 'Allow this?'
}

/**
 * A write the agent asked to make, inline: what it would do, then Allow / Cancel (a thumbs up or a
 * fist, as on the Confirm card). Nothing runs until it is allowed. Answered, it says how.
 */
function ConfirmBubble({ m }: { m: Extract<ChatMessage, { kind: 'confirm' }> }): React.JSX.Element {
  const Icon = CONFIRM_ICONS[m.details.kind]
  return (
    <div className={`bubble bubble--agent bubble--confirm bubble--confirm-${m.status}`}>
      <p className="cf__ask">{CONFIRM_ASK[m.details.kind]}</p>
      <div className="cf__details">
        <Icon className="cf__icon" size={16} strokeWidth={1.9} aria-hidden />
        <div className="cf__lines">
          <ConfirmLines details={m.details} />
        </div>
      </div>
      {m.status === 'pending' ? (
        <div className="cf__actions">
          <button type="button" className="cf__btn cf__btn--allow" onClick={() => controller.tap('primary')}>
            <ThumbsUp size={13} strokeWidth={2.2} aria-hidden />
            Allow
          </button>
          <button type="button" className="cf__btn" onClick={() => controller.tap('secondary')}>
            <HandFist size={13} strokeWidth={2.2} aria-hidden />
            Cancel
          </button>
        </div>
      ) : (
        <p className={`cf__status cf__status--${m.status}`} role="status">
          {m.status === 'allowed' ? <Check size={13} strokeWidth={2.6} aria-hidden /> : null}
          {m.status === 'allowed' ? 'Allowed' : 'Cancelled'}
        </p>
      )}
    </div>
  )
}

/** The Confirm card's details, compact: the event's title and time, the recipient and the text. */
function ConfirmLines({ details }: { details: ConfirmDetails }): React.JSX.Element {
  switch (details.kind) {
    case 'event': {
      const extra = [details.guestsLabel, details.videoLabel].filter(Boolean).join(' · ')
      return (
        <>
          <p className="cf__title">{details.title}</p>
          <p className="cf__line">{[details.dateLabel, details.timeLabel].filter(Boolean).join(' · ')}</p>
          {extra ? <p className="cf__line cf__line--dim">{extra}</p> : null}
        </>
      )
    }
    case 'mail':
      return (
        <>
          <p className="cf__title cf__title--addr" title={`To ${details.to}`}>
            {details.to}
          </p>
          {details.subject ? <p className="cf__line">{details.subject}</p> : null}
          <p className="cf__line cf__line--clamp cf__line--dim">{details.body}</p>
        </>
      )
    case 'message':
      return (
        <>
          <p className="cf__title cf__title--addr" title={`To ${details.to}`}>
            {details.to}
          </p>
          <p className="cf__line cf__line--clamp">{details.text}</p>
        </>
      )
    case 'generic':
      return (
        <>
          <p className="cf__title">{details.title}</p>
          {details.lines.map((line, i) => (
            <p key={i} className="cf__line">
              {line}
            </p>
          ))}
        </>
      )
  }
}

/**
 * The message being signed: each word as it is recognized (the newest brightest), with a caret.
 * Listening pulses it; with nothing signed yet it is a quiet placeholder, so the card keeps its
 * height as movements come and go.
 */
function ComposingBubble({
  composer,
  words,
  placeholder,
  first
}: {
  composer: Composer
  words: string[]
  placeholder: string
  first: boolean
}): React.JSX.Element {
  const { composing, listening } = composer
  const newest = words.at(-1)
  const state = words.length ? 'live' : listening ? 'waiting' : 'idle'
  return (
    <div className={`chat__row chat__row--you${first ? ' chat__row--first' : ''}`}>
      {composing.label ? <span className="chat__who">{composing.label}</span> : null}
      <p className={`bubble bubble--composing bubble--${state}${listening ? ' bubble--listening' : ''}`} aria-label="Message being signed">
        {state === 'live' ? (
          <>
            {words.length > 1 ? `${words.slice(0, -1).join(' ')} ` : null}
            <span key={`${words.length}:${newest}`} className="compose__new">
              {newest}
            </span>
            <span key={words.length} className="compose__caret" aria-hidden />
          </>
        ) : state === 'waiting' ? (
          <span className="compose__dots" aria-label="Listening">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span className="compose__placeholder">{placeholder}</span>
        )}
      </p>
    </div>
  )
}

function ChatFooter({ items }: { items: (string | HintItem)[] }): React.JSX.Element {
  const cameraOn = useApp((s) => s.cameraOn)
  const captioning = useApp((s) => s.captioning)
  return (
    <footer className="chatcard__footer">
      <IconButton
        icon={cameraOn ? Camera : CameraOff}
        label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
        tone={cameraOn ? 'light' : 'dim'}
        size={28}
        iconSize={17}
        onClick={() => controller.tap('camera')}
      />
      {/* Captions mode: on, what you sign is captions for the call; off, it goes to the agent. */}
      <IconButton
        icon={captioning ? Captions : CaptionsOff}
        label={captioning ? 'Captions on: signs go to the call. Turn off' : 'Captions off: signs go to the agent. Turn on'}
        tone={captioning ? 'light' : 'dim'}
        size={28}
        iconSize={17}
        onClick={() => controller.tap('captions')}
      />
      <Hint items={items} className="chatcard__hint" />
      <IconButton icon={ChevronDown} label="Minimize" size={28} iconSize={17} onClick={() => controller.tap('collapse')} />
    </footer>
  )
}

/** What a thumbs up opens, in the hint. */
function openLabel(view: ViewAction): string {
  switch (view.kind) {
    case 'openFile':
      return imagePath(view) ? 'open in Preview' : 'open the file'
    case 'openApp':
      return `open ${view.app}`
    case 'openUrl':
      return 'open in the browser'
  }
}

/** The gestures that act now, by phase. */
function hintFor(view: ChatCardView): (string | HintItem)[] {
  switch (view.kind) {
    case 'recognizing':
    case 'building':
      if (view.kind === 'recognizing' && view.token === null) break
      return ['hands down to send', 'swipe ← delete']
    case 'confirm':
      return [
        { icon: ThumbsUp, label: 'allow' },
        { icon: HandFist, label: 'cancel' }
      ]
    case 'conversation':
      if (view.phase !== 'reply') return [{ icon: HandFist, label: 'fist to stop' }]
      if (view.answer?.view) return [{ icon: ThumbsUp, label: openLabel(view.answer.view) }, 'sign to reply']
      // No "fist = hide" here: in Command mode a fist no longer hides the card (signs start with one).
      return ['sign to reply']
    case 'ready':
      break
  }
  return ['sign to talk', { icon: ThumbsUp, label: 'menu' }]
}
