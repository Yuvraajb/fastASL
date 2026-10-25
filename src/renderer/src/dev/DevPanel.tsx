import { MOCK_SCENES } from '../app/mocks'
import { applyScene } from '../app/scenes'
import { useApp, setApp } from '../app/store'
import { simulateGesture } from './useDevCommands'
import type { SimGesture } from '@shared/types'
import { live } from '../app/live'
import { useEffect, useState } from 'react'
import './devpanel.css'

const GESTURES: SimGesture[] = [
  'palmHold', 'thumbsUp', 'fist', 'swipeLeft', 'swipeRight', 'swipeUp',
  'fingers1', 'fingers2', 'fingers3', 'fingers4', 'fingers5', 'handsDown', 'signToken'
]

/** Hidden dev menu (Option+0): jump to any mock state, simulate gestures, FPS. */
export function DevPanel(): React.JSX.Element | null {
  const open = useApp((s) => s.devPanel)
  const [fps, setFps] = useState(0)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setFps(live.fps), 500)
    return () => clearInterval(t)
  }, [open])
  if (!open) return null
  return (
    <div className="devpanel">
      <div className="devpanel__row">
        <strong>dev</strong>
        <span>{fps.toFixed(0)} fps</span>
        <button onClick={() => setApp({ devPanel: false })}>×</button>
      </div>
      <div className="devpanel__grid">
        {Object.keys(MOCK_SCENES).map((id) => (
          <button key={id} onClick={() => applyScene(id)}>
            {id}
          </button>
        ))}
      </div>
      <div className="devpanel__grid">
        {GESTURES.map((g) => (
          <button key={g} onClick={() => simulateGesture(g)}>
            {g}
          </button>
        ))}
      </div>
    </div>
  )
}
