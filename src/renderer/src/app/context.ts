import { Controller } from './controller'
import { ipcServices, mockServices } from './services'

/**
 * Real main-process services by default. Mocks for screenshots, `?mock=1` (which also
 * keeps the camera off) and FASTASL_MOCK=1 (the camera stays live).
 */
function usesMockServices(): boolean {
  const api = window.fastasl
  const forceMock = new URLSearchParams(location.search).get('mock') === '1'
  return !api || forceMock || api.isScreenshotMode || api.mockServices
}

export const controller = new Controller(usesMockServices() ? mockServices() : ipcServices())

/**
 * The dev footer badge: which LLM answers the card (LLM_PROVIDER, e.g. "gemini"), or "mock" when
 * the renderer runs on mock services. Null outside dev mode and on the screenshot stage.
 */
export const llmBadge: string | null = (() => {
  const api = window.fastasl
  const stage = new URLSearchParams(location.search).get('stage') === '1'
  if (!api?.isDev || api.isScreenshotMode || stage) return null
  return usesMockServices() ? 'mock' : api.llmProvider || null
})()
