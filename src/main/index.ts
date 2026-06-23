import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { inspectProject, scanProject } from './scanner'
import { ProviderReviewError, getCliApiKeySettings, getCliPathSettings, getCustomModelSettings, getProviderStatuses, reviewWithCustomModel, reviewWithProvider, saveCliApiKey, saveCliPath, saveCustomModelSettings } from './providers'
import { loadDecisions, saveDecision } from './decisions'
import { installProvider } from './installer'
import { scanReportToExcel, scanReportToMarkdown } from './report'
import { compileRuleConfigs, loadRuleConfigState, loadRuleConfigs, resetRuleConfigs, saveRuleConfigs } from './rules'
import type { CliProviderId, CustomModelSettings, FindingStatus, ModelCallLog, ProviderId, ReportExportFormat, ScanReport, SensitiveFieldRuleConfig } from './types'

if (process.platform === 'darwin') process.env.PATH = [join(app.getPath('userData'), 'node/bin'), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(delimiter)

const modelCallLogs: ModelCallLog[] = []

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#f6f8fb',
    title: '敏感信息体检',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('repository:select', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择需要检查的代码目录' })
    return result.canceled ? null : inspectProject(result.filePaths[0])
  })

  ipcMain.handle('repository:inspect', (_event, path: string) => inspectProject(path))
  ipcMain.handle('providers:status', () => getProviderStatuses())
  ipcMain.handle('provider:install', (_event, provider: 'qoder' | 'codebuddy') => installProvider(provider))
  ipcMain.handle('custom-model:get', () => getCustomModelSettings())
  ipcMain.handle('custom-model:save', (_event, settings: Omit<CustomModelSettings, 'apiKeyConfigured'>) => saveCustomModelSettings(settings))
  ipcMain.handle('cli-api-keys:get', () => getCliApiKeySettings())
  ipcMain.handle('cli-api-key:save', (_event, provider: 'qoder' | 'codebuddy', apiKey: string) => saveCliApiKey(provider, apiKey))
  ipcMain.handle('cli-paths:get', () => getCliPathSettings())
  ipcMain.handle('cli-path:save', (_event, provider: CliProviderId, cliPath: string) => saveCliPath(provider, cliPath))
  ipcMain.handle('field-rules:get', () => loadRuleConfigState())
  ipcMain.handle('field-rules:save', (_event, configs: SensitiveFieldRuleConfig[]) => saveRuleConfigs(configs))
  ipcMain.handle('field-rules:reset', () => resetRuleConfigs())
  ipcMain.handle('model-logs:get', () => [...modelCallLogs].reverse())
  ipcMain.handle('report:export', async (_event, report: ScanReport, format: ReportExportFormat = 'markdown') => {
    const isExcel = format === 'excel'
    const result = await dialog.showSaveDialog({
      title: isExcel ? '导出 Excel 报告' : '导出 Markdown 报告',
      defaultPath: `${report.project.name}-敏感信息体检报告.${isExcel ? 'xlsx' : 'md'}`,
      filters: [isExcel ? { name: 'Excel', extensions: ['xlsx'] } : { name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, isExcel ? scanReportToExcel(report) : scanReportToMarkdown(report), isExcel ? undefined : 'utf8')
    return true
  })
  ipcMain.handle('external:open', (_event, url: string) => shell.openExternal(url))
  ipcMain.handle('finding:decide', (_event, id: string, status: Extract<FindingStatus, 'confirmed' | 'safe'>) => saveDecision(id, status))
  ipcMain.handle('scan:start', async (_event, path: string, provider: ProviderId): Promise<ScanReport> => {
    const started = Date.now()
    const rules = compileRuleConfigs(await loadRuleConfigs())
    const result = await scanProject(path, rules)
    let findings = result.findings
    let providerMessage: string | undefined
    if (provider !== 'local' && findings.length > 0) {
      const log: ModelCallLog = {
        id: `${started}-${provider}`,
        provider,
        startedAt: new Date().toISOString(),
        status: 'running',
        candidateCount: findings.length,
        message: '正在复核候选问题',
      }
      modelCallLogs.push(log)
      if (modelCallLogs.length > 100) modelCallLogs.shift()
      const modelStarted = Date.now()
      try {
        findings = provider === 'custom' ? await reviewWithCustomModel(findings) : await reviewWithProvider(provider, path, findings)
        log.status = 'success'
        log.message = `复核完成，返回 ${findings.length} 项结果`
      } catch (error) {
        providerMessage = error instanceof Error ? error.message : 'AI 复核失败，已保留本地规则结果。'
        log.status = 'error'
        log.message = providerMessage.slice(0, 500)
        log.details = error instanceof ProviderReviewError
          ? error.details
          : error instanceof Error
            ? error.stack ?? error.message
            : undefined
      } finally {
        log.durationMs = Date.now() - modelStarted
      }
    }
    const decisions = await loadDecisions()
    findings = findings.map((finding) => decisions[finding.id] ? { ...finding, status: decisions[finding.id] } : finding)
    return {
      project: result.project,
      provider,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      scannedFiles: result.project.files,
      findings,
      providerMessage,
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
