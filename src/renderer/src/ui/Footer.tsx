import type { ReactNode } from 'react'
import { Camera, CameraOff, ChevronDown, MicOff } from 'lucide-react'
import { controller, llmBadge } from '../app/context'
import { useApp } from '../app/store'
import { IconButton } from './IconButton'
import './Footer.css'

export interface FooterProps {
  /** Camera toggle, left (controller.tap('camera')). Default true. */
  camera?: boolean
  /** "No audio" indicator, center. Default false. */
  micOff?: boolean
  /** Collapse chevron, right (controller.tap('collapse')). Default true. */
  collapse?: boolean
  /** Small "fastASL" label in the center (reference image 1 style). */
  brand?: boolean
  /** Custom center content; replaces mic-off / brand. */
  children?: ReactNode
  className?: string
}

/** Bottom row of 32px icon buttons: camera | center | chevron. */
export function Footer({ camera = true, micOff = false, collapse = true, brand = false, children, className }: FooterProps): React.JSX.Element {
  const cameraOn = useApp((s) => s.cameraOn)
  const center =
    children ??
    (micOff ? (
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
