import { useEffect } from 'react'
import { useApp, setApp } from './app/store'
import { controller } from './app/context'
import { mockPoseFor } from './app/controller'
import { live } from './app/live'
import { startEngines } from './app/engines'
import { CardShell } from './ui/CardShell'
import { ViewRenderer } from './views/ViewRenderer'
import { DevPanel } from './dev/DevPanel'
import { Stage } from './dev/Stage'
import { useDevCommands } from './dev/useDevCommands'
import { followCaptionWindow, publishCaptions } from './captions/publish'

const params = new URLSearchParams(location.search)
const isStage = params.get('stage') === '1'
/** Screenshots and ?mock=1 keep the mock hand: the camera never starts there. */
const liveCamera = Boolean(window.fastasl) && !isStage && !window.fastasl.isScreenshotMode && params.get('mock') !== '1'

export default function App(): React.JSX.Element {
  const view = useApp((s) => s.view)
  useDevCommands()

  useEffect(() => {
    let disposed = false
    let stopEngines: (() => void) | null = null
    if (window.fastasl?.nativeVibrancy) document.documentElement.dataset.vibrancy = '1'
    void window.fastasl?.getEnvStatus().then((keyStatus) => setApp({ keyStatus }))
    void window.fastasl?.getContactAliases?.().then((contactAliases) => setApp({ contactAliases }))
    void controller.loadTemplates()
    void controller.loadGestures()
    void controller.loadSettings().then(() => {
      if (liveCamera && !disposed) stopEngines = startEngines(controller)
    })
    return () => {
      disposed = true
      stopEngines?.()
      controller.dispose()
    }
  }, [])

  // The caption camera window (FaceTime via OBS) shows what is being signed; while it is open, a
  // signed phrase is captions for the call, not a message for the agent.
  useEffect(() => {
    if (isStage) return undefined
    const stopPublish = publishCaptions()
    const stopFollow = followCaptionWindow((open) => controller.setCaptioning(open))
    return () => {
      stopPublish()
      stopFollow()
    }
  }, [])

  // The panel takes the keyboard only for a text field. As it gives it back, Chromium focuses the
  // first button (a stray focus ring on the X), so buttons never keep focus.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      if (e.target instanceof HTMLButtonElement) e.target.blur()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  // Without a live camera the feed shows a mock hand that matches the state.
  useEffect(() => {
    if (!isStage) live.mockPose = mockPoseFor(view)
  }, [view])

  const card = (
    <CardShell view={view} stage={isStage}>
      <ViewRenderer view={view} />
      {window.fastasl?.isDev && !isStage ? <DevPanel /> : null}
    </CardShell>
  )
  return isStage ? <Stage>{card}</Stage> : card
}
