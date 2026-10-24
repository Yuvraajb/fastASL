import { useEffect, useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { controller } from '../../app/context'
import { LETTERS, settingsOptions, STARTER_WORDS } from '../../app/controller'
import { Feed, IconButton, OptionList, Panel } from '../../ui'
import { COMPACT_STRIP_ASPECT, FULL_ASPECT, fingersHint, SettingsFrame, type PageOf, type SettingsState } from './SettingsFrame'
import './TeachPages.css'

type PageProps<P extends 'teachPick' | 'teachSpell' | 'teachRecord'> = { view: SettingsState; page: PageOf<P> }

/** Must match the controller's page size for teachPick (4 words + "Spell a new word"). */
const TEACH_PAGE = 4

/** Pick a starter word or letter to record; swipe pages through the list (dots = pages). Recorded ones show their count. */
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

function PageDots({ count, current }: { count: number; current: number }): React.JSX.Element {
  return (
    <span className="teach-dots" role="img" aria-label={`Page ${current + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={`teach-dots__dot${i === current ? ' teach-dots__dot--on' : ''}`} />
      ))}
    </span>
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
