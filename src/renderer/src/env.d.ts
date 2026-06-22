/// <reference types="vite/client" />

import type { SensiScanApi } from '../../preload'

declare global {
  interface Window {
    sensiScan: SensiScanApi
  }
}

export {}
