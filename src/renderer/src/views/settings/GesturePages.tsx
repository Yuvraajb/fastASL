import { GESTURE_PAGE, settingsOptions } from '../../app/controller'
import { Feed, OptionList, Panel } from '../../ui'
import {
  COMPACT_STRIP_ASPECT,
  FULL_ASPECT,
  fingersHint,
  PageDots,
  SettingsFrame,
  type PageOf,
  type SettingsState
} from './SettingsFrame'
import './GesturePages.css'

type GesturePage = 'newGesturePick' | 'newGestureHold' | 'gestures' | 'gestureDetail'
type PageProps<P extends GesturePage> = { view: SettingsState; page: PageOf<P> }

/** Pick the task a new hand shape should run (recent tasks + "Sign a new task"). */
export function NewGesturePickPage({ view, page }: PageProps<'newGesturePick'>): React.JSX.Element {
  const labels = settingsOptions(page)
  const last = labels.length - 1
  return (
    <SettingsFrame view={view} title="New gesture" subtitle="Pick a task" hint={fingersHint(labels.length)}>
      <OptionList options={labels.map((label, i) => ({ label, muted: i === last }))} />
    </SettingsFrame>
  )
}

/**
 * Record the shape: 3-2-1 in the feed's top-right corner (the hand is in the middle and must
 * stay visible), then a ring that fills while the shape is recorded. A refused shape says why,
 * and thumbs up records it again.
 */
export function NewGestureHoldPage({ view, page }: PageProps<'newGestureHold'>): React.JSX.Element {
  const recording = page.countdown === 0
  const feed = (
    <div className="shape-feed">
      <Feed aspect={FULL_ASPECT} />
      {page.reason ? null : (
        // Keyed so the ring restarts on every tick.
        <div
          key={page.countdown}
          className={`shape-feed__count${recording ? ' shape-feed__count--rec' : ''}`}
          role="timer"
          aria-live="assertive"
          aria-label={recording ? 'Recording' : undefined}
        >
          <svg className="shape-feed__ring" viewBox="0 0 44 44" aria-hidden>
            <circle cx="22" cy="22" r="20" />
          </svg>
          {recording ? <span className="shape-feed__dot" aria-hidden /> : page.countdown}
        </div>
      )}
    </div>
  )
  return (
    <SettingsFrame
      view={view}
      title="Hold your new shape still"
      subtitle={page.task}
      feed={feed}
      // While the shape is formed it may read as a fist, so only a swipe goes back then.
      hint={page.reason ? ['thumbs up = try again', 'fist = back'] : ['swipe ← back']}
    >
      {page.reason ? (
        <p className="shape-reason" role="status">
          {page.reason}
        </p>
      ) : null}
    </SettingsFrame>
  )
}

/** Saved shapes (name + task), built-in first and tagged; swipes page through a long list. */
export function GesturesPage({ view, page }: PageProps<'gestures'>): React.JSX.Element {
  const gestures = page.gestures.slice(page.offset, page.offset + settingsOptions(page).length)
  const pages = Math.ceil(page.gestures.length / GESTURE_PAGE)
  return (
    <SettingsFrame
      view={view}
      title="My gestures"
      aside={pages > 1 ? <PageDots count={pages} current={Math.floor(page.offset / GESTURE_PAGE)} /> : null}
      // Four two-line rows: the shorter strip keeps the card as tall as Teach a sign's.
      feed={gestures.length > 3 ? <Feed aspect={COMPACT_STRIP_ASPECT} /> : undefined}
      hint={pages > 1 ? fingersHint(gestures.length, 'swipe = more') : fingersHint(gestures.length)}
    >
      {gestures.length ? (
        <OptionList options={gestures.map((g) => ({ label: g.name, sub: g.task, tag: g.builtin ? 'built-in' : undefined }))} />
      ) : (
        <Panel className="gesture-empty">No gestures yet. Pick “New gesture” in Settings.</Panel>
      )}
    </SettingsFrame>
  )
}

export function GestureDetailPage({ view, page }: PageProps<'gestureDetail'>): React.JSX.Element {
  const labels = settingsOptions(page)
  return (
    <SettingsFrame
      view={view}
      title={page.gesture.name}
      subtitle={page.gesture.task}
      aside={page.gesture.builtin ? <span className="gesture-tag">built-in</span> : null}
      hint={fingersHint(labels.length)}
    >
      <OptionList options={labels} />
    </SettingsFrame>
  )
}
