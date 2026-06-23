import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CliApiKeySettings, CliPathSettings, CliProviderId, CustomModelSettings, FindingStatus, ModelCallLog, ProjectInfo, ProviderId, ProviderStatus, ReportExportFormat, ScanReport, SensitiveFieldRuleConfig, SensitiveFieldRuleConfigState } from '../main/types'

const api = {
  selectRepository: (): Promise<ProjectInfo | null> => ipcRenderer.invoke('repository:select'),
  inspectRepository: (path: string): Promise<ProjectInfo> => ipcRenderer.invoke('repository:inspect', path),
  getProviderStatuses: (): Promise<ProviderStatus[]> => ipcRenderer.invoke('providers:status'),
  installProvider: (provider: Extract<ProviderId, 'qoder' | 'codebuddy'>): Promise<void> => ipcRenderer.invoke('provider:install', provider),
  getCustomModelSettings: (): Promise<CustomModelSettings> => ipcRenderer.invoke('custom-model:get'),
  saveCustomModelSettings: (settings: Omit<CustomModelSettings, 'apiKeyConfigured'>): Promise<CustomModelSettings> => ipcRenderer.invoke('custom-model:save', settings),
  getCliApiKeySettings: (): Promise<CliApiKeySettings> => ipcRenderer.invoke('cli-api-keys:get'),
  saveCliApiKey: (provider: CliProviderId, apiKey: string): Promise<CliApiKeySettings> => ipcRenderer.invoke('cli-api-key:save', provider, apiKey),
  getCliPathSettings: (): Promise<CliPathSettings> => ipcRenderer.invoke('cli-paths:get'),
  saveCliPath: (provider: CliProviderId, cliPath: string): Promise<CliPathSettings> => ipcRenderer.invoke('cli-path:save', provider, cliPath),
  getFieldRules: (): Promise<SensitiveFieldRuleConfigState> => ipcRenderer.invoke('field-rules:get'),
  saveFieldRules: (configs: SensitiveFieldRuleConfig[]): Promise<SensitiveFieldRuleConfig[]> => ipcRenderer.invoke('field-rules:save', configs),
  resetFieldRules: (): Promise<SensitiveFieldRuleConfig[]> => ipcRenderer.invoke('field-rules:reset'),
  getModelCallLogs: (): Promise<ModelCallLog[]> => ipcRenderer.invoke('model-logs:get'),
  exportReport: (report: ScanReport, format: ReportExportFormat = 'markdown'): Promise<boolean> => ipcRenderer.invoke('report:export', report, format),
  startScan: (path: string, provider: ProviderId): Promise<ScanReport> => ipcRenderer.invoke('scan:start', path, provider),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('external:open', url),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  saveDecision: (id: string, status: Extract<FindingStatus, 'confirmed' | 'safe'>): Promise<void> => ipcRenderer.invoke('finding:decide', id, status),
}

contextBridge.exposeInMainWorld('sensiScan', api)

export type SensiScanApi = typeof api
