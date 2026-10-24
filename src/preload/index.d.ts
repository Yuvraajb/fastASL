import type { FastAslApi } from '../shared/ipc'

declare global {
  interface Window {
    fastasl: FastAslApi
  }
}

export {}
