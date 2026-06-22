import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CustomModelSettings, FindingStatus, ProjectInfo, ProviderId, ProviderStatus, ScanReport } from '../main/types'

const api = {
  selectRepository: (): Promise<ProjectInfo | null> => ipcRenderer.invoke('repository:select'),
  inspectRepository: (path: string): Promise<ProjectInfo> => ipcRenderer.invoke('repository:inspect', path),
  getProviderStatuses: (): Promise<ProviderStatus[]> => ipcRenderer.invoke('providers:status'),
  installProvider: (provider: Extract<ProviderId, 'qoder' | 'codebuddy'>): Promise<void> => ipcRenderer.invoke('provider:install', provider),
  getCustomModelSettings: (): Promise<CustomModelSettings> => ipcRenderer.invoke('custom-model:get'),
  saveCustomModelSettings: (settings: Omit<CustomModelSettings, 'apiKeyConfigured'>): Promise<CustomModelSettings> => ipcRenderer.invoke('custom-model:save', settings),
  startScan: (path: string, provider: ProviderId): Promise<ScanReport> => ipcRenderer.invoke('scan:start', path, provider),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('external:open', url),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  saveDecision: (id: string, status: Extract<FindingStatus, 'confirmed' | 'safe'>): Promise<void> => ipcRenderer.invoke('finding:decide', id, status),
}

contextBridge.exposeInMainWorld('sensiScan', api)

export type SensiScanApi = typeof api
