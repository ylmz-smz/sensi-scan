import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { inspectProject, scanProject } from './scanner'
import { getCustomModelSettings, getProviderStatuses, reviewWithCustomModel, reviewWithProvider, saveCustomModelSettings } from './providers'
import { loadDecisions, saveDecision } from './decisions'
import { installProvider } from './installer'
import type { CustomModelSettings, FindingStatus, ProviderId, ScanReport } from './types'

if (process.platform === 'darwin') process.env.PATH = [join(app.getPath('userData'), 'node/bin'), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(delimiter)

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
  ipcMain.handle('external:open', (_event, url: string) => shell.openExternal(url))
  ipcMain.handle('finding:decide', (_event, id: string, status: Extract<FindingStatus, 'confirmed' | 'safe'>) => saveDecision(id, status))
  ipcMain.handle('scan:start', async (_event, path: string, provider: ProviderId): Promise<ScanReport> => {
    const started = Date.now()
    const result = await scanProject(path)
    let findings = result.findings
    let providerMessage: string | undefined
    if (provider !== 'local') {
      try {
        findings = provider === 'custom' ? await reviewWithCustomModel(findings) : await reviewWithProvider(provider, path, findings)
      } catch (error) {
        providerMessage = error instanceof Error ? error.message : 'AI 复核失败，已保留本地规则结果。'
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
