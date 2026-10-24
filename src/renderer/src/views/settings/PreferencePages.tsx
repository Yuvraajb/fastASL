import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Camera, Gauge, GraduationCap, Laptop, Link, Shapes, Sparkles, Wifi, type LucideIcon } from 'lucide-react'
import { controller } from '../../app/context'
import { settingsOptions } from '../../app/controller'
import { useApp } from '../../app/store'
import { OptionList, useLiveError, type OptionItem } from '../../ui'
import { fingersHint, SettingsFrame, type PageOf, type SettingsState } from './SettingsFrame'
import './PreferencePages.css'

type PageProps<P extends 'root' | 'camera' | 'sensitivity'> = { view: SettingsState; page: PageOf<P> }

const ROOT_ICONS: LucideIcon[] = [GraduationCap, Sparkles, Shapes, Camera, Gauge]

/**
 * Settings home: five entries picked by finger count. No page title: the header status
 * already reads "Settings". Icon rows put the number on the right, like the quick menu.
 */
export function RootPage({ view, page }: PageProps<'root'>): React.JSX.Element {
  const labels = settingsOptions(page)
  return (
    <SettingsFrame view={view} hint={fingersHint(labels.length)}>
      <OptionList options={labels.map((label, i) => ({ label, icon: ROOT_ICONS[i] }))} />
    </SettingsFrame>
  )
}

const LEVEL_NOTES = ['Longer holds, fewer false triggers', 'Balanced speed and accuracy', 'Faster, more sensitive']
const LEVELS = ['low', 'medium', 'high'] as const

export function SensitivityPage({ view, page }: PageProps<'sensitivity'>): React.JSX.Element {
  const labels = settingsOptions(page)
  return (
    <SettingsFrame view={view} title="Sensitivity" subtitle="How quickly holds and signs register" hint={fingersHint(labels.length)}>
      <OptionList options={labels.map((label, i) => ({ label, sub: LEVEL_NOTES[i] }))} selected={LEVELS.indexOf(page.current)} />
    </SettingsFrame>
  )
}

const CAMERA_ICONS: LucideIcon[] = [Laptop, Wifi, Link]
const URL_PLACEHOLDER = 'http://192.168.1.50:81/stream'

/**
 * Picks the camera by finger count (or a click). The feed above shows the chosen source at
 * once; why it can't run (live.error, or why a stream gave way to the MacBook camera) shows
 * in full below the list, since the feed's own line is cut to one.
 */
export function CameraPage({ view, page }: PageProps<'camera'>): React.JSX.Element {
  const notice = useApp((s) => s.notice)
  const cameraOn = useApp((s) => s.cameraOn)
  const cameraError = useLiveError(cameraOn)

  const items: OptionItem[] = settingsOptions(page).map((label, i) => ({ label, icon: CAMERA_ICONS[i] }))
  items[1] = { ...items[1], sub: page.url || 'No stream URL yet', mono: Boolean(page.url) }

  return (
    <SettingsFrame
      view={view}
      title="Camera source"
      hint={page.editing ? ['Return saves', 'Esc or swipe ← cancels'] : fingersHint(items.length)}
      notice={notice ?? (cameraOn ? cameraError : null)}
      noticeLines={4}
    >
      <OptionList options={items} selected={page.current === 'builtin' ? 0 : 1} />
      {page.editing ? <UrlField url={page.url} /> : null}
    </SettingsFrame>
  )
}

/** Inline URL input. The overlay window takes keyboard focus only while it is open. Return saves, Esc closes it. */
function UrlField({ url }: { url: string }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(url)

  useEffect(() => {
    window.fastasl?.setFocusable(true)
    ref.current?.focus()
    ref.current?.select()
    return () => window.fastasl?.setFocusable(false)
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') controller.saveStreamUrl(value)
    else if (e.key === 'Escape') controller.tap('close')
  }

  return (
    <input
      ref={ref}
      className="set-url"
      type="url"
      value={value}
      placeholder={URL_PLACEHOLDER}
      spellCheck={false}
      autoComplete="off"
      aria-label="Stream URL"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={() => window.fastasl?.setFocusable(true)}
      onBlur={() => window.fastasl?.setFocusable(false)}
    />
  )
}
