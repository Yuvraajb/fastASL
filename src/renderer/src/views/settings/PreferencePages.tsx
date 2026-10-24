import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Camera, Gauge, GraduationCap, Laptop, Link, Shapes, Sparkles, Wifi, type LucideIcon } from 'lucide-react'
import { controller } from '../../app/context'
import { settingsOptions } from '../../app/controller'
import { useApp } from '../../app/store'
import { OptionList, type OptionItem } from '../../ui'
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
const EDIT_URL = 2
/** The controller's answer to "Edit stream URL" (finger pick); it reveals the input here. */
const EDIT_URL_NOTICE = 'Type the URL, then press Return'
const URL_PLACEHOLDER = 'http://192.168.1.50:81/stream'

export function CameraPage({ view, page }: PageProps<'camera'>): React.JSX.Element {
  const notice = useApp((s) => s.notice)
  const [editing, setEditing] = useState(false)

  // A finger pick of option 3 only reaches the controller, which posts EDIT_URL_NOTICE.
  useEffect(() => {
    if (notice === EDIT_URL_NOTICE) setEditing(true)
  }, [notice])

  const items: OptionItem[] = settingsOptions(page).map((label, i) => ({ label, icon: CAMERA_ICONS[i] }))
  items[1] = { ...items[1], sub: page.url || 'No stream URL yet', mono: Boolean(page.url) }

  const pick = (i: number): void => {
    if (i === EDIT_URL) setEditing(true)
    controller.tap('option', i)
  }

  return (
    <SettingsFrame view={view} title="Camera source" hint={editing ? ['Return saves', 'Esc cancels'] : fingersHint(items.length)}>
      <OptionList options={items} selected={page.current === 'builtin' ? 0 : 1} onPick={pick} />
      {editing ? <UrlField page={page} onDone={() => setEditing(false)} /> : null}
    </SettingsFrame>
  )
}

/** Inline URL input. The overlay window only takes keyboard focus while it is focused. */
function UrlField({ page, onDone }: { page: PageOf<'camera'>; onDone: () => void }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(page.url)

  useEffect(() => {
    window.fastasl?.setFocusable(true)
    ref.current?.focus()
    ref.current?.select()
    return () => window.fastasl?.setFocusable(false)
  }, [])

  const save = (): void => {
    const url = value.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) {
      controller.notify('Enter a URL starting with http://')
      return
    }
    void window.fastasl?.saveSettings({ cameraSource: { kind: 'mjpeg', url } })
    controller.notify(null)
    controller.setView({ kind: 'settings', settings: { page: 'camera', current: 'mjpeg', url } })
    onDone()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') save()
    else if (e.key === 'Escape') {
      controller.notify(null)
      onDone()
    }
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
