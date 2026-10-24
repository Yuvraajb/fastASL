import { setApp } from './store'
import { MOCK_SCENES } from './mocks'
import { live } from './live'
import { controller } from './context'

/** Apply a mock scene by id (dev menu, hotkeys, screenshots). */
export function applyScene(id: string): boolean {
  const scene = MOCK_SCENES[id]
  if (!scene) return false
  controller.setView(scene.view)
  setApp({
    mode: scene.mode ?? 'command',
    notice: scene.notice ?? null,
    holdProgress: scene.holdProgress ?? 0,
    pick: scene.pick ?? null
  })
  live.mockPose = scene.pose ?? 'palm'
  return true
}
