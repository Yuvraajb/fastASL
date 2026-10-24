import { LETTERS, settingsOptions, STARTER_WORDS } from '../../app/controller'
import { Feed, OptionList, Panel } from '../../ui'
import { COMPACT_STRIP_ASPECT, FULL_ASPECT, fingersHint, SettingsFrame, type PageOf, type SettingsState } from './SettingsFrame'
import './TeachPages.css'

type PageProps<P extends 'teachPick' | 'teachSpell' | 'teachRecord'> = { view: SettingsState; page: PageOf<P> }

/** Must match the controller's page size for teachPick (4 words + "Spell a new word"). */
const TEACH_PAGE = 4

/** Pick a starter word or letter to record; swipe pages through the list (dots = pages). */
export function TeachPickPage({ view, page }: PageProps<'teachPick'>): React.JSX.Element {
  const labels = settingsOptions(page)
  const pages = Math.ceil((STARTER_WORDS.length + LETTERS.length) / TEACH_PAGE)
  const current = Math.floor(page.offset / TEACH_PAGE)
  const last = labels.length - 1
  return (
    <SettingsFrame
      view={view}
      title="Teach a sign"
      aside={<PageDots count={pages} current={current} />}
      feed={<Feed aspect={COMPACT_STRIP_ASPECT} />}
      hint={fingersHint(labels.length, 'swipe = more')}
    >
      <OptionList options={labels.map((label, i) => ({ label, muted: i === last }))} />
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

/** Fingerspell a new word to teach; thumbs up finishes. */
export function TeachSpellPage({ view, page }: PageProps<'teachSpell'>): React.JSX.Element {
  return (
    <SettingsFrame
      view={view}
      title="Spell the new word"
      subtitle="Fingerspell, thumbs up when done"
      feed={<Feed aspect={2} />}
      hint={['fist = back']}
    >
      <Panel className="teach-spell">
        <span className="teach-spell__letters" aria-live="polite">
          {page.letters}
        </span>
        <span className="teach-spell__caret" aria-hidden />
      </Panel>
    </SettingsFrame>
  )
}

/** Record samples of one sign: big prompt, sample counter and a segment per sample. */
export function TeachRecordPage({ view, page }: PageProps<'teachRecord'>): React.JSX.Element {
  const next = Math.min(page.done + 1, page.total)
  return (
    <SettingsFrame
      view={view}
      feed={<Feed aspect={FULL_ASPECT} />}
      hint={['fist = back']}
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
        <p className="teach-rec__hint">
          <span className="teach-rec__pulse" aria-hidden />
          Recording automatically
        </p>
      </div>
    </SettingsFrame>
  )
}
