import { useEffect, useState } from 'react'
import { useApp } from '../app/store'
import { MODE_LABEL, statusFor, type StatusInfo, type View } from '../app/types'
import { StatusLabel } from './StatusLabel'
import { CloseButton } from './CloseButton'
import './Header.css'

/**
 * Cards where a movement being judged shows as "Listening..." in the header (store.signing). The
 * conversation card takes signs only once the agent has answered (controller.takesSigns).
 */
const SIGNING_VIEWS: ReadonlySet<View['kind']> = new Set(['ready', 'recognizing', 'building', 'conversation', 'dictation'])
const LISTENING: StatusInfo = { label: 'Listening...', tone: 'active' }

/** How long the mode label stays highlighted after a swipe switches modes. */
const MODE_FLASH_MS = 1600

export interface HeaderProps {
  /** Current view: the status label comes from statusFor(view, mode). */
  view: View
  /** Override the status label; null hides it. */
  status?: StatusInfo | null
  /** Show a small circular X top-right (calls onClose, default controller.tap('close')). */
  close?: boolean
  onClose?: () => void
  title?: string
}

function useModeFlash(): boolean {
  const at = useApp((s) => s.modeFlashAt)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    const left = MODE_FLASH_MS - (performance.now() - at)
    if (!at || left <= 0) return
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), left)
    return () => clearTimeout(t)
  }, [at])
  return flashing
}

/** Card header: "fastASL" (+ subtle mode label) left, status (and optional X) right. */
export function Header({ view, status, close = false, onClose, title = 'fastASL' }: HeaderProps): React.JSX.Element {
  const mode = useApp((s) => s.mode)
  const signing = useApp((s) => s.signing)
  const flashing = useModeFlash()
  const live = SIGNING_VIEWS.has(view.kind) ? (signing ? LISTENING : null) : null
  const info = status === undefined ? (live ?? statusFor(view, mode)) : status
  const showMode = mode !== 'command' || flashing
  return (
    <header className="hdr">
      <div className="hdr__left">
        <span className="hdr__title">{title}</span>
        {showMode ? <span className={`hdr__mode${flashing ? ' hdr__mode--flash' : ''}`}>{MODE_LABEL[mode]}</span> : null}
      </div>
      <div className="hdr__right">
        {info ? <StatusLabel label={info.label} tone={info.tone} /> : null}
        {close ? <CloseButton variant="plain" size={20} onClick={onClose} className="hdr__close" /> : null}
      </div>
    </header>
  )
}
