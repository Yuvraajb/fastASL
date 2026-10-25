import type { ReactNode } from 'react'
import { Camera, CameraOff, ChevronDown, MessageSquare, Mic, MicOff, Settings } from 'lucide-react'
import { controller, llmBadge } from '../app/context'
import { getApp, setApp, useApp } from '../app/store'
import { IconButton } from './IconButton'
import './Footer.css'

export interface FooterProps {
  /** Camera toggle, left (controller.tap('camera')). Default true. */
  camera?: boolean
  /** "No audio" indicator, center. Default false. */
  micOff?: boolean
  /** Collapse chevron, right (controller.tap('collapse')). Default true. */
  collapse?: boolean
  /** Settings gear, right of the chevron (controller.tap('settings')). Default false. */
  settings?: boolean
  /** Chat button, left of the gear (controller.tap('chat')). Default false. */
  chat?: boolean
  /** Listening switch in the center: click to turn signing on or off (or Option+Space). Default false. */
  listen?: boolean
  /** Small "fastASL" label in the center (reference image 1 style). */
  brand?: boolean
  /** Custom center content; replaces mic-off / brand. */
  children?: ReactNode
  className?: string
}

/** Bottom row of 32px icon buttons: camera | center | chevron. */
export function Footer({ camera = true, micOff = false, collapse = true, settings = false, chat = false, listen = false, brand = false, children, className }: FooterProps): React.JSX.Element {
  const cameraOn = useApp((s) => s.cameraOn)
  const center =
    children ??
    (listen ? (
      <ListenButton />
    ) : micOff ? (
      <IconButton icon={MicOff} label="No audio: fastASL only uses your hands" tone="dim" indicator />
    ) : brand ? (
      <span className="footer__brand">fastASL</span>
    ) : null)
  return (
    <footer className={`footer${llmBadge ? ' footer--badge' : ''}${className ? ` ${className}` : ''}`}>
      <div className="footer__side">
        {camera ? (
          <IconButton
            icon={cameraOn ? Camera : CameraOff}
            label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
            tone={cameraOn ? 'light' : 'dim'}
            onClick={() => controller.tap('camera')}
          />
        ) : null}
      </div>
      <div className="footer__center">{center}</div>
      <div className="footer__side footer__side--end">
        {chat ? <IconButton icon={MessageSquare} label="Chat with AI" onClick={() => controller.tap('chat')} /> : null}
        {settings ? <IconButton icon={Settings} label="Settings" onClick={() => controller.tap('settings')} /> : null}
        {collapse ? <IconButton icon={ChevronDown} label="Minimize" onClick={() => controller.tap('collapse')} /> : null}
      </div>
      {llmBadge ? (
        <span className="footer__llm" aria-hidden>
          {llmBadge}
        </span>
      ) : null}
    </footer>
  )
}

/** Listening switch: click to turn signing on (green), click again to turn it off. Option+Space does the same. */
function ListenButton(): React.JSX.Element {
  const listening = useApp((s) => s.listening)
  const toggle = (): void => {
    const on = !getApp().listening
    if (window.fastasl?.isDev) console.log(`[listen] ${on ? 'on' : 'off'}`)
    setApp({ listening: on })
  }
  return (
    <button
      type="button"
      className={`icon-btn icon-btn--${listening ? 'light' : 'dim'} footer__listen${listening ? ' footer__listen--on' : ''}`}
      style={{ width: 44, height: 32 }}
      role="switch"
      aria-checked={listening}
      aria-label={listening ? 'Listening: click to turn off' : 'Click to start listening'}
      title={listening ? 'Listening (click or Option+Space to turn off)' : 'Click to start listening (or Option+Space)'}
      onClick={toggle}
    >
      <Mic size={20} strokeWidth={1.9} aria-hidden />
    </button>
  )
}
