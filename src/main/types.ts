export type ProviderId = 'local' | 'custom' | 'qoder' | 'codebuddy'
export type Severity = 'high' | 'medium' | 'low'
export type FindingStatus = 'confirmed' | 'suspected' | 'safe'

export interface ProjectInfo {
  path: string
  name: string
  files: number
  technologies: string[]
}

export interface Finding {
  id: string
  severity: Severity
  status: FindingStatus
  sensitiveType: string
  title: string
  reason: string
  file: string
  line: number
  snippet: string
  route: string
  api: string
  suggestion: string
}

export interface ProviderStatus {
  id: ProviderId
  name: string
  available: boolean
  command?: string
  version?: string
  helpUrl?: string
}

export interface CustomModelSettings {
  baseUrl: string
  model: string
  apiKey?: string
  apiKeyConfigured: boolean
}

export interface ScanReport {
  project: ProjectInfo
  provider: ProviderId
  startedAt: string
  durationMs: number
  scannedFiles: number
  findings: Finding[]
  providerMessage?: string
}
