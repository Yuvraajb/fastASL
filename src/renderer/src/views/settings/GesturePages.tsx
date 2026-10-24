import { settingsOptions } from '../../app/controller'
import { CheckBadge, Feed, OptionList, Panel } from '../../ui'
import { FULL_ASPECT, fingersHint, SettingsFrame, type PageOf, type SettingsState } from './SettingsFrame'
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
 * Capture the shape: 3-2-1 in the feed's top-right corner (the hand is in the middle and
 * must stay visible), then a centered check once saved.
 */
export function NewGestureHoldPage({ view, page }: PageProps<'newGestureHold'>): React.JSX.Element {
  const counting = !page.captured && page.countdown > 0
  const feed = (
    <div className="shape-feed">
      <Feed aspect={FULL_ASPECT} />
      <div className={`shape-feed__overlay${counting ? ' shape-feed__overlay--corner' : ''}`}>
        {page.captured ? (
          <div className="shape-feed__badge" role="status">
            <CheckBadge size={36} />
            <span>Saved</span>
          </div>
        ) : counting ? (
          // Keyed so the ring restarts on every tick.
          <div key={page.countdown} className="shape-feed__count" role="timer" aria-live="assertive">
            <svg className="shape-feed__ring" viewBox="0 0 44 44" aria-hidden>
              <circle cx="22" cy="22" r="20" />
            </svg>
            {page.countdown}
          </div>
        ) : null}
      </div>
    </div>
  )
  return (
    <SettingsFrame
      view={view}
      title={page.captured ? 'New gesture saved' : 'Hold your new shape still'}
      subtitle={page.task || 'New task: sign it next'}
      feed={feed}
      hint={['fist = back']}
    />
  )
}

/** Saved shapes (name + task); built-ins are tagged. */
export function GesturesPage({ view, page }: PageProps<'gestures'>): React.JSX.Element {
  const gestures = page.gestures.slice(0, settingsOptions(page).length)
  return (
    <SettingsFrame view={view} title="My gestures" hint={fingersHint(gestures.length)}>
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
