import { useEffect, useRef, useState } from 'react'
import type { CaptionState } from '@shared/types'
import { openRealCameraStream } from '../engine/camera/cameraSource'
import './CaptionCamera.css'

/** How long the last sent message stays up after the hands drop. */
const LAST_MS = 8000

/**
 * The caption camera window (see src/main/captionWindow.ts): the camera, unmirrored as the other
 * person on a call sees it, with large captions of what the user signs. The words being signed
 * stream in live; the sentence that was just sent stays up for LAST_MS.
 */
export function CaptionCamera(): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [captions, setCaptions] = useState<CaptionState>({ live: '', last: '', lastAt: 0 })
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'fastASL Captions'
    let stream: MediaStream | null = null
    let stopped = false
    // The Mac's own camera, not OBS's Virtual Camera (which macOS can make the default).
    openRealCameraStream()
      .then((s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop())
        stream = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play()
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    const off = window.fastasl?.onCaptions(setCaptions)
    const tick = setInterval(() => setNow(Date.now()), 500)
    return () => {
      stopped = true
      stream?.getTracks().forEach((t) => t.stop())
      off?.()
      clearInterval(tick)
    }
  }, [])

  const showLast = !captions.live && captions.last && now - captions.lastAt < LAST_MS
  const text = captions.live || (showLast ? captions.last : '')
  return (
    <div className="capcam">
      <video ref={video} className="capcam__video" muted playsInline />
      {error ? <p className="capcam__error">Camera unavailable: {error}</p> : null}
      <div className="capcam__badge">ASL → captions · fastASL</div>
      {text ? (
        <div className={`capcam__captions${captions.live ? ' capcam__captions--live' : ''}`}>
          <span className="capcam__text">{text}</span>
          {captions.live ? <span className="capcam__caret" aria-hidden /> : null}
        </div>
      ) : null}
    </div>
  )
}
