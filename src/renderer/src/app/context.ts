import { Controller } from './controller'
import { ipcServices, mockServices, type Services } from './services'

/**
 * Real main-process services by default. Mocks for screenshots, `?mock=1` (which also
 * keeps the camera off) and FASTASL_MOCK=1 (the camera stays live).
 */
function pickServices(): Services {
  const api = window.fastasl
  const forceMock = new URLSearchParams(location.search).get('mock') === '1'
  if (!api || forceMock || api.isScreenshotMode || api.mockServices) return mockServices()
  return ipcServices()
}

export const controller = new Controller(pickServices())
