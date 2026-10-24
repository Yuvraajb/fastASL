import { useEffect, type ReactNode } from 'react'
import { MOCK_SCENES, SCREENSHOT_ORDER } from '../app/mocks'
import { applyScene } from '../app/scenes'
import './stage.css'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Screenshot stage: a fake macOS desktop (menu bar + wallpaper) with the card in
 * the top-right corner, used by `npm run screens` to render every state to
 * docs/screens/NN-<id>.png for comparison with docs/reference.
 */
export function Stage({ children }: { children: ReactNode }): React.JSX.Element {
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(location.search)
    const only = (params.get('only') ?? '').split(',').filter(Boolean)
    const ids = SCREENSHOT_ORDER.filter((id) => MOCK_SCENES[id] && (!only.length || only.includes(id)))
    void (async () => {
      await document.fonts.ready
      await wait(400)
      for (let i = 0; i < ids.length && !cancelled; i++) {
        const id = ids[i]
        const n = SCREENSHOT_ORDER.indexOf(id) + 1
        applyScene(id)
        await wait(700)
        await window.fastasl.capture(`${String(n).padStart(2, '0')}-${id}`)
      }
      if (!cancelled && params.get('keep') !== '1') window.fastasl.quit()
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="stage">
      <div className="stage__wallpaper" />
      <div className="stage__menubar">
        <span className="stage__apple"></span>
        <span className="stage__clock">Fri Oct 25&nbsp;&nbsp;10:00 AM</span>
      </div>
      {children}
    </div>
  )
}
