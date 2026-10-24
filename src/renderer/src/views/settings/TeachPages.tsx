import { useEffect, useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { controller } from '../../app/context'
import { IDENTIFYING, LETTERS, settingsOptions, STARTER_WORDS, TEACH_PAGE } from '../../app/controller'
import { Feed, IconButton, OptionList, Panel, Spinner } from '../../ui'
import {
  COMPACT_STRIP_ASPECT,
  FULL_ASPECT,
  fingersHint,
  PageDots,
  SettingsFrame,
  STRIP_ASPECT,
  type PageOf,
  type SettingsState
} from './SettingsFrame'
import './TeachPages.css'

type PageProps<P extends 'teachPick' | 'teachSpell' | 'teachRecord' | 'teachShow'> = { view: SettingsState; page: PageOf<P> }

/**
 * Show me a sign first, then a page of starter words or letters to record, then Spell a new
 * word; swipe pages through the list (dots = pages). Recorded ones show their count.
 */
export function TeachPickPage({ view, page }: PageProps<'teachPick'>): React.JSX.Element {
  const labels = settingsOptions(page)
  const pages = Math.ceil((STARTER_WORDS.length + LETTERS.length) / TEACH_PAGE)
  const current = Math.floor(page.offset / TEACH_PAGE)
  const last = labels.length - 1
  const options = labels.map((label, i) => {
    const count = page.recorded[label]
    return { label, muted: i === last, detail: count ? `${count} recorded` : undefined }
  })
  return (
    <SettingsFrame
      view={view}
      title="Teach a sign"
      aside={<PageDots count={pages} current={current} />}
      feed={<Feed aspect={COMPACT_STRIP_ASPECT} />}
      hint={fingersHint(labels.length, 'swipe = more')}
    >
      <OptionList options={options} />
    </SettingsFrame>
  )
}

/** Fingerspell (once letters are taught) or type a new word to teach; thumbs up records it. */
export function TeachSpellPage({ view, page }: PageProps<'teachSpell'>): React.JSX.Element {
  const [typing, setTyping] = useState(false)
  // With no letters left a swipe goes back too: a taught S held here is a letter, not a fist.
  const gestures = [page.letters ? 'swipe ← delete' : 'swipe ← back', 'fist = back']
  return (
    <SettingsFrame
      view={view}
      title="Spell the new word"
      subtitle={page.canSpell ? 'Fingerspell or type, thumbs up when done' : 'No letters taught yet: type the word'}
      feed={<Feed aspect={2} />}
      hint={typing ? ['Return records it', 'Esc stops typing'] : gestures}
    >
      <Panel className="teach-spell">
        {typing ? (
          <WordField letters={page.letters} onDone={() => setTyping(false)} />
        ) : (
          <>
            <span className="teach-spell__letters" aria-live="polite">
              {page.letters}
            </span>
            <span className="teach-spell__caret" aria-hidden />
            <IconButton
              icon={Keyboard}
              label="Type the word"
              size={30}
              iconSize={16}
              className="teach-spell__type"
              onClick={() => setTyping(true)}
            />
          </>
        )}
      </Panel>
    </SettingsFrame>
  )
}

/**
 * Keyboard entry for the new word. The overlay never takes focus on its own, so the window
 * is focusable only while this field is open. Every keystroke goes through the controller
 * (upper case, letters, digits and spaces), so thumbs up or fingerspelling continue the typed word.
 */
function WordField({ letters, onDone }: { letters: string; onDone: () => void }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.fastasl?.setFocusable(true)
    const el = ref.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
    return () => window.fastasl?.setFocusable(false)
  }, [])

  return (
    <input
      ref={ref}
      className="teach-spell__input"
      value={letters}
      placeholder="NEW WORD"
      spellCheck={false}
      autoComplete="off"
      aria-label="New word"
      onChange={(e) => controller.setTeachWord(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') {
          e.preventDefault()
          controller.confirmTeachWord()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onDone()
        }
      }}
    />
  )
}

/** What Show me a sign is doing: waiting, hearing a movement, asking the LLM, or why the last try gave nothing. */
function showStatus(page: PageOf<'teachShow'>): { text: string; tone: 'idle' | 'listening' | 'retry' | 'busy' } {
  if (page.phase === 'identifying') return { text: IDENTIFYING, tone: 'busy' }
  if (page.phase === 'listening') return { text: 'Listening...', tone: 'listening' }
  if (page.reason) return { text: page.reason, tone: 'retry' }
  return { text: 'Waiting for a sign', tone: 'idle' }
}

/**
 * Teach › Show me a sign: the user signs a word once and the LLM guesses it ("Is this HELLO?").
 * A pick learns that one repetition; "None of these" leads to the list, where a word is
 * recorded the usual way.
 */
export function TeachShowPage({ view, page }: PageProps<'teachShow'>): React.JSX.Element {
  if (page.phase === 'guess') {
    const labels = settingsOptions(page)
    const last = labels.length - 1
    return (
      <SettingsFrame
        view={view}
        title={`Is this ${labels[0]}?`}
        subtitle="Pick the word you signed"
        feed={<Feed aspect={STRIP_ASPECT} />}
        hint={fingersHint(labels.length, 'thumbs up = 1')}
      >
        <OptionList options={labels.map((label, i) => ({ label, muted: i === last }))} />
      </SettingsFrame>
    )
  }
  const status = showStatus(page)
  return (
    <SettingsFrame
      view={view}
      title="Show me a sign"
      subtitle="Sign one word once, then hold still"
      feed={<Feed aspect={FULL_ASPECT} />}
      hint={['fist = back']}
    >
      <p className={`teach-rec__hint teach-rec__hint--${status.tone === 'busy' ? 'listening' : status.tone}`} aria-live="polite">
        {status.tone === 'busy' ? <Spinner size={12} /> : status.tone === 'retry' ? null : <span className="teach-rec__pulse" aria-hidden />}
        {status.text}
      </p>
    </SettingsFrame>
  )
}

/** What the recorder is doing, under the segments. */
function recordStatus(page: PageOf<'teachRecord'>): { text: string; tone: 'idle' | 'listening' | 'retry' } {
  if (page.listening) return { text: 'Listening...', tone: 'listening' }
  if (page.reason) return { text: page.reason, tone: 'retry' }
  return { text: page.kind === 'letter' ? 'Hold the letter still' : 'Recording automatically', tone: 'idle' }
}

/** Record samples of one sign: big prompt, sample counter, a segment per sample and the recorder's state. */
export function TeachRecordPage({ view, page }: PageProps<'teachRecord'>): React.JSX.Element {
  const next = Math.min(page.done + 1, page.total)
  const status = recordStatus(page)
  return (
    <SettingsFrame
      view={view}
      feed={<Feed aspect={FULL_ASPECT} />}
      // Letters are held still and S or T read as a fist, so letters go back with a swipe.
      hint={[page.kind === 'letter' ? 'swipe ← back' : 'fist = back']}
    >
      <div className="teach-rec">
        <div className="teach-rec__prompt">
          <span className="teach-rec__sign">
            <span className="teach-rec__verb">Sign</span> {page.label.toUpperCase()}
          </span>
          <span className="teach-rec__count">
            {next} of {page.total}
          </span>
        </div>
        <div className="teach-rec__segs" role="progressbar" aria-valuemin={0} aria-valuemax={page.total} aria-valuenow={page.done}>
          {Array.from({ length: page.total }, (_, i) => (
            <span
              key={i}
              className={`teach-rec__seg${i < page.done ? ' teach-rec__seg--done' : i === page.done ? ' teach-rec__seg--next' : ''}`}
            />
          ))}
        </div>
        <p className={`teach-rec__hint teach-rec__hint--${status.tone}`} aria-live="polite">
          {status.tone === 'retry' ? null : <span className="teach-rec__pulse" aria-hidden />}
          {status.text}
        </p>
      </div>
    </SettingsFrame>
  )
}
