import type { ReactNode } from 'react'
import type { SettingsPage, View } from '../../app/types'
import { Feed, Header, Hint, Notice, SectionTitle, Stack, type HintItem } from '../../ui'
import './SettingsFrame.css'

export type SettingsState = Extract<View, { kind: 'settings' }>
export type PageOf<P extends SettingsPage['page']> = Extract<SettingsPage, { page: P }>
export type HintItems = readonly (string | HintItem)[]

/**
 * Feed strip on list pages: the hand stays visible while picking by finger count.
 * Anything much wider crops raised fingertips.
 */
export const STRIP_ASPECT = 2.4
/** Shorter strip (97px) for the tallest list page, title + 5 rows (teach pick), so the card stays under 400px. */
export const COMPACT_STRIP_ASPECT = 2.8
/** Full feed where the user has to watch themselves sign (recording, shape capture). */
export const FULL_ASPECT = 16 / 10

/** ["hold 1–5 fingers", "fist = back"], sized to the number of options on the page. */
export function fingersHint(count: number, ...extra: string[]): HintItems {
  if (count <= 0) return [...extra, 'fist = back']
  return [`hold ${count === 1 ? '1 finger' : `1–${count} fingers`}`, ...extra, 'fist = back']
}

/** One dot per page of a paged list (swipes page through it), the current one highlighted. */
export function PageDots({ count, current }: { count: number; current: number }): React.JSX.Element {
  return (
    <span className="set-dots" role="img" aria-label={`Page ${current + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={`set-dots__dot${i === current ? ' set-dots__dot--on' : ''}`} />
      ))}
    </span>
  )
}

interface SettingsFrameProps {
  view: SettingsState
  /** Omit when the header status already names the page (root) or the body brings its own heading (teach record). */
  title?: string
  subtitle?: ReactNode
  /** Right of the title block (page dots, tags). */
  aside?: ReactNode
  /** Defaults to the feed strip. */
  feed?: ReactNode
  /** Help line under everything, segments joined by a middle dot. */
  hint: HintItems
  /** Defaults to store.notice. */
  notice?: string | null
  /** Lines the notice shows before an ellipsis (Notice's default: 2). */
  noticeLines?: number
  children?: ReactNode
}

/**
 * Shared settings layout: header (status "Settings" + X = back), feed, page title, body,
 * notice, hint. Each page is its own component, so moving between pages remounts this
 * and the fade below plays (CardShell only fades on a change of view kind).
 */
export function SettingsFrame({ view, title, subtitle, aside, feed, hint, notice, noticeLines, children }: SettingsFrameProps): React.JSX.Element {
  return (
    <Stack className="set-page">
      <Header view={view} close />
      {feed ?? <Feed aspect={STRIP_ASPECT} />}
      <Stack gap={6}>
        {title ? (
          <div className="set-title">
            <div className="set-title__text">
              <SectionTitle>{title}</SectionTitle>
              {subtitle ? <p className="set-title__sub">{subtitle}</p> : null}
            </div>
            {aside ? <div className="set-title__aside">{aside}</div> : null}
          </div>
        ) : null}
        {children}
      </Stack>
      <Notice text={notice} lines={noticeLines} />
      <Hint items={hint} />
    </Stack>
  )
}
