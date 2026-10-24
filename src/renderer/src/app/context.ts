import { Controller } from './controller'
import { ipcServices, mockServices, type Services } from './services'

/**
 * Mock services are used for screenshots and when FASTASL_MOCK=1 / ?mock=1.
 * Phase 1 ships with mocks only; later phases flip the default to the real IPC services.
 */
function pickServices(): Services {
  const params = new URLSearchParams(location.search)
  const forceMock = params.get('mock') === '1' || window.fastasl?.isScreenshotMode
  if (forceMock || !window.fastasl) return mockServices()
  return USE_REAL_SERVICES ? ipcServices() : mockServices()
}

/** Flipped to true once the main-process services exist (Phase 5+). */
const USE_REAL_SERVICES = false

export const controller = new Controller(pickServices())
