import { setApp } from './store'
import { MOCK_SCENES, sceneChat } from './mocks'
import { live } from './live'
import { controller } from './context'

/** Apply a mock scene by id (dev menu, hotkeys, screenshots). */
export function applyScene(id: string): boolean {
  const scene = MOCK_SCENES[id]
  if (!scene) return false
  controller.setView(scene.view)
  const derived = sceneChat(scene.view)
  setApp({
    mode: scene.mode ?? 'command',
    notice: scene.notice ?? null,
    holdProgress: scene.holdProgress ?? 0,
    pick: scene.pick ?? null,
    signing: scene.signing ?? false,
    chat: scene.chat ?? derived.chat,
    composing: scene.composing ?? derived.composing
  })
  live.mockPose = scene.pose ?? 'palm'
  // The pipeline owns live.error wherever a camera can run.
  if (window.fastasl?.isScreenshotMode) live.error = scene.error ?? null
  return true
}
