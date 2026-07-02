export type ProviderId = 'local' | 'custom' | 'qoder' | 'codebuddy'
export type CliProviderId = Extract<ProviderId, 'qoder' | 'codebuddy'>

export const CLI_API_KEY_ENV: Record<CliProviderId, string> = {
  qoder: 'QODER_PERSONAL_ACCESS_TOKEN',
  codebuddy: 'CODEBUDDY_API_KEY',
}
export type Severity = 'high' | 'medium' | 'low'
export type FindingStatus = 'confirmed' | 'suspected' | 'safe'

export interface SensitiveFieldRuleConfig {
  id: string
  type: string
  keywords: string[]
  severity: Severity
  suggestion: string
  enabled: boolean
}

export interface SensitiveFieldRuleConfigState {
  configs: SensitiveFieldRuleConfig[]
  usingDefaults: boolean
  error?: string
}

export interface CompiledSensitiveRule {
  type: string
  pattern: RegExp
  severity: Severity
  suggestion: string
}

export type ReportExportFormat = 'markdown' | 'excel'

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
  context?: string
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
  apiKeyConfigured?: boolean
  searchedPaths?: string[]
}

export interface CustomModelSettings {
  baseUrl: string
  model: string
  apiKey?: string
  apiKeyConfigured: boolean
}

export interface CliApiKeySettings {
  qoderConfigured: boolean
  codebuddyConfigured: boolean
}

export type CliPathSettings = Record<CliProviderId, string>

export interface ModelCallLog {
  id: string
  provider: Exclude<ProviderId, 'local'>
  startedAt: string
  durationMs?: number
  status: 'running' | 'success' | 'error'
  candidateCount: number
  message: string
  details?: string
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
