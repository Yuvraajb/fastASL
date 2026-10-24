import { useEffect, useState } from 'react'
import { useApp } from '../app/store'
import { MODE_LABEL, statusFor, type StatusInfo, type View } from '../app/types'
import { StatusLabel } from './StatusLabel'
import { CloseButton } from './CloseButton'
import './Header.css'

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
  const flashing = useModeFlash()
  const info = status === undefined ? statusFor(view, mode) : status
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
