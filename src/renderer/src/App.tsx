import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle,
  Code,
  Copy,
  DownloadSimple,
  FileCode,
  FolderOpen,
  Gear,
  Info,
  ListMagnifyingGlass,
  LockKey,
  Play,
  ShieldCheck,
  Warning,
  X,
} from '@phosphor-icons/react'
import type { CliApiKeySettings, CliPathSettings, CliProviderId, CustomModelSettings, Finding, ModelCallLog, ProjectInfo, ProviderId, ProviderStatus, ScanReport, SensitiveFieldRuleConfig } from '../../main/types'

type Screen = 'home' | 'scanning' | 'results'

const scanStages = ['读取项目结构', '识别敏感字段', '检查展示和输出位置', '生成体检报告']

const providerDescriptions: Record<ProviderId, string> = {
  local: '完全离线，使用内置规则快速检查',
  custom: '使用你配置的 OpenAI 兼容模型复核候选问题',
  qoder: '调用已登录的 Qoder CLI 复核疑似问题',
  codebuddy: '调用已登录的 CodeBuddy CLI 复核疑似问题',
}

function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('home')
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [provider, setProvider] = useState<ProviderId>('local')
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [report, setReport] = useState<ScanReport | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stage, setStage] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [installing, setInstalling] = useState<Extract<ProviderId, 'qoder' | 'codebuddy'> | null>(null)
  const scanRun = useRef(0)

  useEffect(() => {
    const refresh = (): void => {
      window.sensiScan.getProviderStatuses().then(setProviders).catch(() => setProviders([]))
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const selectedFinding = useMemo(
    () => report?.findings.find((finding) => finding.id === selectedId) ?? report?.findings[0] ?? null,
    [report, selectedId],
  )

  async function selectRepository(): Promise<void> {
    setError(null)
    try {
      const selected = await window.sensiScan.selectRepository()
      if (selected) setProject(selected)
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : '无法读取该目录。')
    }
  }

  async function inspectDroppedFile(file: File): Promise<void> {
    const path = window.sensiScan.pathForFile(file)
    if (!path) return
    setError(null)
    try {
      setProject(await window.sensiScan.inspectRepository(path))
    } catch {
      setError('请拖入一个可读取的代码目录。')
    }
  }

  async function startScan(): Promise<void> {
    if (!project) return
    const runId = scanRun.current + 1
    scanRun.current = runId
    setScreen('scanning')
    setError(null)
    setStage(0)
    const timer = window.setInterval(() => setStage((current) => Math.min(current + 1, scanStages.length - 1)), 900)
    try {
      const nextReport = await window.sensiScan.startScan(project.path, provider)
      if (scanRun.current !== runId) return
      setReport(nextReport)
      setSelectedId(nextReport.findings[0]?.id ?? null)
      setStage(scanStages.length)
      window.setTimeout(() => setScreen('results'), 350)
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : '扫描失败，请确认目录权限后重试。')
      setScreen('home')
    } finally {
      window.clearInterval(timer)
    }
  }

  async function installCli(id: Extract<ProviderId, 'qoder' | 'codebuddy'>): Promise<void> {
    setError(null)
    setInstalling(id)
    try {
      await window.sensiScan.installProvider(id)
      setProviders(await window.sensiScan.getProviderStatuses())
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : '安装失败，请查看官网安装说明。')
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand" onClick={() => setScreen('home')} aria-label="返回首页">
          <span className="brand-mark"><ShieldCheck size={22} weight="fill" /></span>
          <span>敏感信息体检</span>
        </button>
        <div className="header-actions">
          <span className="privacy-note"><LockKey size={15} /> 默认仅在本机读取代码</span>
          <button className="icon-button" onClick={() => setLogsOpen(true)} aria-label="查看大模型调用日志">
            <ListMagnifyingGlass size={20} />
          </button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="打开设置">
            <Gear size={20} />
          </button>
        </div>
      </header>

      <main className="app-main">
        {screen === 'home' && (
          <HomeScreen
            project={project}
            provider={provider}
            providers={providers}
            installing={installing}
            error={error}
            onSelect={selectRepository}
            onDrop={inspectDroppedFile}
            onProviderChange={setProvider}
            onInstall={(url) => window.sensiScan.openExternal(url)}
            onInstallCli={installCli}
            onConfigure={() => setSettingsOpen(true)}
            onStart={startScan}
          />
        )}
        {screen === 'scanning' && project && <ScanningScreen project={project} stage={stage} onCancel={() => {
          scanRun.current += 1
          setScreen('home')
        }} />}
        {screen === 'results' && report && (
          <ResultsScreen
            report={report}
            selectedFinding={selectedFinding}
            onSelectFinding={setSelectedId}
            onBack={() => setScreen('home')}
            onUpdateFinding={(id, status) => {
              window.sensiScan.saveDecision(id, status).catch(() => undefined)
              setReport((current) => current ? {
                ...current,
                findings: current.findings.map((finding) => finding.id === id ? { ...finding, status } : finding),
              } : current)
            }}
          />
        )}
      </main>

      {settingsOpen && <SettingsDialog providers={providers} onProvidersChange={setProviders} onClose={() => setSettingsOpen(false)} />}
      {logsOpen && <ModelLogsDialog onClose={() => setLogsOpen(false)} />}
    </div>
  )
}

interface HomeProps {
  project: ProjectInfo | null
  provider: ProviderId
  providers: ProviderStatus[]
  installing: Extract<ProviderId, 'qoder' | 'codebuddy'> | null
  error: string | null
  onSelect: () => void
  onDrop: (file: File) => void
  onProviderChange: (provider: ProviderId) => void
  onInstall: (url: string) => void
  onInstallCli: (provider: Extract<ProviderId, 'qoder' | 'codebuddy'>) => void
  onConfigure: () => void
  onStart: () => void
}

function HomeScreen({ project, provider, providers, installing, error, onSelect, onDrop, onProviderChange, onInstall, onInstallCli, onConfigure, onStart }: HomeProps): ReactElement {
  return (
    <section className="home-layout">
      <div className="intro-column">
        <div className="eyebrow"><ShieldCheck size={16} weight="fill" /> 本地代码安全检查</div>
        <h1>选择代码目录，<br />开始一次敏感信息体检</h1>
        <p className="intro-copy">自动检查手机号、身份证、银行卡等信息是否在页面、接口、日志或导出中完整展示。</p>
        <div className="trust-list">
          <span><CheckCircle size={18} weight="fill" /> 无需初始化配置</span>
          <span><CheckCircle size={18} weight="fill" /> 自动识别项目技术栈</span>
          <span><CheckCircle size={18} weight="fill" /> AI 复核可选且只读</span>
        </div>
      </div>

      <div className="action-column">
        <div
          className={`drop-zone ${project ? 'has-project' : ''}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            const file = event.dataTransfer.files[0]
            if (file) onDrop(file)
          }}
        >
          {project ? (
            <>
              <div className="folder-illustration selected"><FolderOpen size={34} weight="duotone" /></div>
              <div className="project-heading">
                <strong>{project.name}</strong>
                <span title={project.path}>{project.path}</span>
              </div>
              <div className="project-meta">
                <span>{project.files} 个代码文件</span>
                {project.technologies.slice(0, 4).map((technology) => <span key={technology}>{technology}</span>)}
              </div>
              <button className="text-button" onClick={onSelect}>重新选择</button>
            </>
          ) : (
            <>
              <div className="folder-illustration"><FolderOpen size={34} weight="duotone" /></div>
              <strong>选择需要检查的代码目录</strong>
              <span>也可以将文件夹拖到这里</span>
              <button className="primary-button" onClick={onSelect}><FolderOpen size={18} /> 选择文件夹</button>
            </>
          )}
        </div>

        <div className="engine-section">
          <div className="section-heading">
            <div>
              <strong>检查方式</strong>
              <span>推荐先使用本地规则，AI 仅复核候选问题</span>
            </div>
            <Info size={18} />
          </div>
          <div className="provider-list">
            {(['local', 'custom', 'qoder', 'codebuddy'] as ProviderId[]).map((id) => {
              const status = providers.find((item) => item.id === id)
              const available = id === 'local' || Boolean(status?.available)
              const statusLabel = id === 'local'
                ? '可用'
                : id === 'custom'
                  ? available ? '已就绪' : '未配置'
                  : !available ? '未检测到 CLI' : status?.apiKeyConfigured ? '已就绪' : 'CLI 已检测'
              return (
                <div className={`provider-row ${provider === id ? 'selected' : ''}`} key={id}>
                  <button disabled={!available} onClick={() => onProviderChange(id)}>
                    <span className="radio"><span /></span>
                    <span className="provider-icon">{id === 'local' ? <ShieldCheck size={20} /> : <Code size={20} />}</span>
                    <span className="provider-copy">
                      <strong>{status?.name ?? (id === 'custom' ? '自定义模型' : id === 'qoder' ? 'Qoder CLI' : 'CodeBuddy CLI')}</strong>
                      <small>{providerDescriptions[id]}</small>
                    </span>
                    <span className={`status-pill ${available ? 'ready' : ''}`}>{statusLabel}</span>
                  </button>
                  {id === 'custom' && !available && <button className="install-link" onClick={onConfigure}>去配置</button>}
                  {(id === 'qoder' || id === 'codebuddy') && available && <button className="install-link" onClick={onConfigure}>配置 Key</button>}
                  {!available && status?.helpUrl && (
                    <div className="provider-actions">
                      <button disabled={Boolean(installing)} onClick={() => onInstallCli(id as Extract<ProviderId, 'qoder' | 'codebuddy'>)}>{installing === id ? '安装中…' : '安装'}</button>
                      <button onClick={() => onInstall(status.helpUrl!)}>官网</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {error && <div className="inline-error"><Warning size={18} weight="fill" /> {error}</div>}
        <button className="scan-button" disabled={!project} onClick={onStart}><Play size={18} weight="fill" /> 开始体检</button>
      </div>
    </section>
  )
}

function ScanningScreen({ project, stage, onCancel }: { project: ProjectInfo; stage: number; onCancel: () => void }): ReactElement {
  const progress = Math.min(100, Math.round(((stage + 0.5) / scanStages.length) * 100))
  return (
    <section className="scanning-screen">
      <div className="scan-orbit"><ShieldCheck size={42} weight="duotone" /></div>
      <p className="scan-project">正在检查 {project.name}</p>
      <h2>{scanStages[Math.min(stage, scanStages.length - 1)]}</h2>
      <p>请保持应用开启。扫描过程不会修改代码。</p>
      <div className="progress-track" aria-label={`扫描进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
      <div className="stage-list">
        {scanStages.map((item, index) => (
          <span className={index < stage ? 'done' : index === stage ? 'active' : ''} key={item}>
            {index < stage ? <Check size={14} weight="bold" /> : <i />}{item}
          </span>
        ))}
      </div>
      <button className="secondary-button" onClick={onCancel}>取消扫描</button>
    </section>
  )
}

interface ResultsProps {
  report: ScanReport
  selectedFinding: Finding | null
  onSelectFinding: (id: string) => void
  onBack: () => void
  onUpdateFinding: (id: string, status: Extract<Finding['status'], 'confirmed' | 'safe'>) => void
}

function ResultsScreen({ report, selectedFinding, onSelectFinding, onBack, onUpdateFinding }: ResultsProps): ReactElement {
  const high = report.findings.filter((item) => item.severity === 'high' && item.status !== 'safe').length
  const suspected = report.findings.filter((item) => item.status === 'suspected').length
  const safe = report.findings.filter((item) => item.status === 'safe').length
  const selectedIndex = selectedFinding ? report.findings.findIndex((item) => item.id === selectedFinding.id) : -1
  const [exportMessage, setExportMessage] = useState<string | null>(null)

  function navigate(offset: number): void {
    const next = report.findings[selectedIndex + offset]
    if (next) onSelectFinding(next.id)
  }

  async function exportReport(format: 'markdown' | 'excel'): Promise<void> {
    setExportMessage(null)
    try {
      if (await window.sensiScan.exportReport(report, format)) setExportMessage(format === 'excel' ? 'Excel 报告已导出。' : 'Markdown 报告已导出。')
    } catch (exportError) {
      setExportMessage(exportError instanceof Error ? exportError.message : '报告导出失败。')
    }
  }

  return (
    <section className="results-screen">
      <div className="results-header">
        <div>
          <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> 返回项目</button>
          <h2>{report.project.name} 体检报告</h2>
          <p>已检查 {report.scannedFiles} 个代码文件，用时 {(report.durationMs / 1000).toFixed(1)} 秒</p>
        </div>
        <div className="results-actions">
          <button className="secondary-button" onClick={() => navigator.clipboard.writeText(JSON.stringify(report, null, 2))}><Copy size={17} /> 复制报告</button>
          <button className="secondary-button" onClick={() => exportReport('excel')}><DownloadSimple size={17} /> 导出 Excel</button>
          <button className="primary-button" onClick={() => exportReport('markdown')}><DownloadSimple size={17} /> 导出 Markdown</button>
        </div>
      </div>

      {exportMessage && <div className="export-message" role="status">{exportMessage}</div>}
      {report.providerMessage && <div className="provider-warning"><Info size={18} /> AI 复核未完成：{report.providerMessage}</div>}

      <div className="summary-strip">
        <div><strong className="danger-text">{high}</strong><span>高风险问题</span></div>
        <div><strong>{suspected}</strong><span>需要确认</span></div>
        <div><strong className="safe-text">{safe}</strong><span>AI 判断安全</span></div>
        <div className="summary-note"><ShieldCheck size={20} /><span>结果按风险优先排列<br /><small>请结合实际页面权限确认</small></span></div>
      </div>

      {report.findings.length === 0 ? (
        <div className="empty-result"><CheckCircle size={44} weight="duotone" /><h3>未发现明显的未脱敏展示</h3><p>本次规则扫描没有找到候选问题，仍建议结合人工抽查确认。</p></div>
      ) : (
        <div className="review-layout">
          <aside className="finding-list">
            <div className="list-title"><strong>待处理问题</strong><span>{report.findings.length}</span></div>
            {report.findings.map((finding) => (
              <button className={finding.id === selectedFinding?.id ? 'active' : ''} key={finding.id} onClick={() => onSelectFinding(finding.id)}>
                <span className={`severity-dot ${finding.severity}`} />
                <span><strong>{finding.title}</strong><small>{finding.file}:{finding.line}</small></span>
                <ArrowRight size={16} />
              </button>
            ))}
          </aside>

          {selectedFinding && (
            <article className="finding-detail">
              <div className="finding-heading">
                <span className={`risk-label ${selectedFinding.severity}`}>{selectedFinding.severity === 'high' ? '高风险' : selectedFinding.severity === 'medium' ? '中风险' : '低风险'}</span>
                <span className="finding-number">问题 {selectedIndex + 1} / {report.findings.length}</span>
              </div>
              <h3>{selectedFinding.title}</h3>
              <p className="reason-copy">{selectedFinding.reason}</p>

              <dl className="evidence-grid">
                <div><dt>敏感信息</dt><dd>{selectedFinding.sensitiveType}</dd></div>
                <div><dt>页面路由</dt><dd>{selectedFinding.route}</dd></div>
                <div><dt>接口路径</dt><dd>{selectedFinding.api}</dd></div>
                <div><dt>代码位置</dt><dd>{selectedFinding.file}:{selectedFinding.line}</dd></div>
              </dl>

              <div className="code-evidence">
                <div><FileCode size={17} /> 证据代码</div>
                <pre><code>{selectedFinding.snippet}</code></pre>
              </div>

              <div className="suggestion-box">
                <ShieldCheck size={21} weight="duotone" />
                <div><strong>建议处理方式</strong><p>{selectedFinding.suggestion}</p></div>
              </div>

              <div className="review-actions">
                <button className="secondary-button" onClick={() => onUpdateFinding(selectedFinding.id, 'safe')}>标记为合理展示</button>
                <button className="primary-button" onClick={() => onUpdateFinding(selectedFinding.id, 'confirmed')}>确认问题</button>
              </div>
              <div className="finding-navigation">
                <button disabled={selectedIndex <= 0} onClick={() => navigate(-1)}><ArrowLeft size={16} /> 上一个</button>
                <button disabled={selectedIndex >= report.findings.length - 1} onClick={() => navigate(1)}>下一个 <ArrowRight size={16} /></button>
              </div>
            </article>
          )}
        </div>
      )}
    </section>
  )
}

function ModelLogsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [logs, setLogs] = useState<ModelCallLog[]>([])
  const [error, setError] = useState(false)

  useEffect(() => {
    window.sensiScan.getModelCallLogs().then(setLogs).catch(() => setError(true))
  }, [])

  const providerNames = { custom: '自定义模型', qoder: 'Qoder CLI', codebuddy: 'CodeBuddy CLI' }
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog model-logs-dialog" role="dialog" aria-modal="true" aria-label="大模型调用日志" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header"><div><h2>大模型调用日志</h2><p>仅记录本次运行中的调用状态；失败时会保留脱敏后的 CLI 输出便于排查。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>
        {error ? <div className="inline-error">日志读取失败。</div> : logs.length === 0 ? <div className="logs-empty">暂无大模型调用记录。</div> : (
          <div className="model-log-list">
            {logs.map((log) => (
              <article key={log.id}>
                <div><strong>{providerNames[log.provider]}</strong><span className={`status-pill log-${log.status}`}>{log.status === 'running' ? '调用中' : log.status === 'success' ? '成功' : '失败'}</span></div>
                <p>{log.message}</p>
                {log.status === 'error' && log.details && (
                  <details className="log-details">
                    <summary>查看失败详情</summary>
                    <pre>{log.details}</pre>
                  </details>
                )}
                <small>{new Date(log.startedAt).toLocaleString()} · {log.candidateCount} 个候选问题{log.durationMs === undefined ? '' : ` · ${(log.durationMs / 1000).toFixed(1)} 秒`}</small>
              </article>
            ))}
          </div>
        )}
        <button className="secondary-button dialog-close" onClick={onClose}>关闭</button>
      </section>
    </div>
  )
}

type FieldRuleDraft = Omit<SensitiveFieldRuleConfig, 'keywords'> & {
  keywordText: string
}

function SettingsDialog({ providers, onProvidersChange, onClose }: { providers: ProviderStatus[]; onProvidersChange: (providers: ProviderStatus[]) => void; onClose: () => void }): ReactElement {
  const [settings, setSettings] = useState<CustomModelSettings>({ baseUrl: '', model: '', apiKey: '', apiKeyConfigured: false })
  const [cliKeys, setCliKeys] = useState<Record<CliProviderId, string>>({ qoder: '', codebuddy: '' })
  const [cliKeySettings, setCliKeySettings] = useState<CliApiKeySettings>({ qoderConfigured: false, codebuddyConfigured: false })
  const [cliPaths, setCliPaths] = useState<CliPathSettings>({ qoder: '', codebuddy: '' })
  const [fieldRules, setFieldRules] = useState<FieldRuleDraft[]>([])
  const [fieldRulesWarning, setFieldRulesWarning] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    window.sensiScan.getCustomModelSettings().then((value) => setSettings({ ...value, apiKey: '' })).catch(() => setMessage('无法读取自定义模型配置。'))
    window.sensiScan.getCliApiKeySettings().then(setCliKeySettings).catch(() => setMessage('无法读取 CLI API Key 配置。'))
    window.sensiScan.getCliPathSettings().then(setCliPaths).catch(() => setMessage('无法读取 CLI 路径配置。'))
    window.sensiScan.getFieldRules().then((state) => {
      setFieldRules(state.configs.map(createFieldRuleDraft))
      setFieldRulesWarning(state.error ?? null)
    }).catch(() => setMessage('无法读取字段检测规则。'))
  }, [])

  async function saveSettings(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setMessage(null)
    try {
      const saved = await window.sensiScan.saveCustomModelSettings({ baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey })
      setSettings({ ...saved, apiKey: '' })
      onProvidersChange(await window.sensiScan.getProviderStatuses())
      setMessage('自定义模型配置已保存。')
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : '保存失败。')
    }
  }

  async function saveCliKey(provider: CliProviderId): Promise<void> {
    setMessage(null)
    try {
      setCliKeySettings(await window.sensiScan.saveCliApiKey(provider, cliKeys[provider]))
      setCliKeys({ ...cliKeys, [provider]: '' })
      onProvidersChange(await window.sensiScan.getProviderStatuses())
      setMessage(`${provider === 'qoder' ? 'Qoder' : 'CodeBuddy'} API Key 已保存。`)
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : '保存失败。')
    }
  }

  async function saveCliPath(provider: CliProviderId): Promise<void> {
    setMessage(null)
    try {
      const saved = await window.sensiScan.saveCliPath(provider, cliPaths[provider])
      setCliPaths(saved)
      onProvidersChange(await window.sensiScan.getProviderStatuses())
      setMessage(`${provider === 'qoder' ? 'Qoder' : 'CodeBuddy'} CLI 路径已保存。`)
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : '保存失败。')
    }
  }

  async function refreshProviders(): Promise<void> {
    setRefreshing(true)
    setMessage(null)
    try {
      onProvidersChange(await window.sensiScan.getProviderStatuses())
      setMessage('CLI 状态已重新检测。')
    } catch {
      setMessage('CLI 状态检测失败。')
    } finally {
      setRefreshing(false)
    }
  }

  function updateFieldRule(id: string, updates: Partial<FieldRuleDraft>): void {
    setFieldRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...updates } : rule))
  }

  function createFieldRuleDraft(rule: SensitiveFieldRuleConfig): FieldRuleDraft {
    return {
      id: rule.id,
      type: rule.type,
      keywordText: rule.keywords.join('\n'),
      severity: rule.severity,
      suggestion: rule.suggestion,
      enabled: rule.enabled,
    }
  }

  function parseKeywords(value: string): string[] {
    return [...new Set(value.split(/[,\n，]/).map((item) => item.trim()).filter(Boolean))]
  }

  function fieldRuleDraftToConfig(rule: FieldRuleDraft): SensitiveFieldRuleConfig {
    return {
      id: rule.id,
      type: rule.type,
      keywords: parseKeywords(rule.keywordText),
      severity: rule.severity,
      suggestion: rule.suggestion,
      enabled: rule.enabled,
    }
  }

  function createFieldRuleId(existingIds: Set<string>): string {
    let id = ''
    do {
      id = `custom-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
    } while (existingIds.has(id))
    return id
  }

  function addFieldRule(): void {
    setFieldRules((current) => {
      const id = createFieldRuleId(new Set(current.map((rule) => rule.id)))
      return [...current, {
        id,
        type: '新增字段',
        keywordText: 'fieldName',
        severity: 'medium',
        suggestion: '请根据业务需要补充脱敏展示规则。',
        enabled: true,
      }]
    })
  }

  async function saveFieldRules(): Promise<void> {
    setMessage(null)
    try {
      const saved = await window.sensiScan.saveFieldRules(fieldRules.map(fieldRuleDraftToConfig))
      setFieldRules(saved.map(createFieldRuleDraft))
      setFieldRulesWarning(null)
      setMessage('字段检测规则已保存。')
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : '字段检测规则保存失败。')
    }
  }

  async function resetFieldRules(): Promise<void> {
    setMessage(null)
    try {
      setFieldRules((await window.sensiScan.resetFieldRules()).map(createFieldRuleDraft))
      setFieldRulesWarning(null)
      setMessage('字段检测规则已恢复默认。')
    } catch {
      setMessage('字段检测规则恢复失败。')
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置与隐私" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header"><div><h2>设置与隐私</h2><p>默认设置已经适合大多数项目。</p></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
        <div className="setting-block">
          <LockKey size={22} />
          <div><strong>代码读取范围</strong><p>本地规则只读取所选目录中的源代码文件，不读取 Git 历史，不修改任何文件。</p></div>
        </div>
        <div className="model-settings">
          <strong>字段检测规则</strong>
          <p>默认规则也可以修改。字段关键词支持逗号、中文逗号或换行分隔，不支持直接输入正则。</p>
          {fieldRulesWarning && <div className="inline-error">{fieldRulesWarning}</div>}
          {fieldRules.map((rule) => (
            <div className="field-rule-row" key={rule.id}>
              <label>字段类型<input value={rule.type} onChange={(event) => updateFieldRule(rule.id, { type: event.target.value })} /></label>
              <label>风险等级
                <select value={rule.severity} onChange={(event) => updateFieldRule(rule.id, { severity: event.target.value as SensitiveFieldRuleConfig['severity'] })}>
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="low">低</option>
                </select>
              </label>
              <label>字段关键词<textarea value={rule.keywordText} rows={3} onChange={(event) => updateFieldRule(rule.id, { keywordText: event.target.value })} /></label>
              <label>处理建议<textarea value={rule.suggestion} rows={2} onChange={(event) => updateFieldRule(rule.id, { suggestion: event.target.value })} /></label>
              <div className="field-rule-actions">
                <label><input type="checkbox" checked={rule.enabled} onChange={(event) => updateFieldRule(rule.id, { enabled: event.target.checked })} /> 启用</label>
                <button className="secondary-button" type="button" onClick={() => setFieldRules((current) => current.filter((item) => item.id !== rule.id))}>删除</button>
              </div>
            </div>
          ))}
          <span className="field-rule-buttons">
            <button className="secondary-button" type="button" onClick={addFieldRule}>新增字段类型</button>
            <button className="secondary-button" type="button" onClick={resetFieldRules}>恢复默认规则</button>
            <button className="primary-button" type="button" onClick={saveFieldRules}>保存字段规则</button>
          </span>
        </div>
        <form className="model-settings" onSubmit={saveSettings}>
          <strong>自定义模型</strong>
          <label>Base URL<input type="url" required value={settings.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label>
          <label>Model<input required value={settings.model} placeholder="model-name" onChange={(event) => setSettings({ ...settings, model: event.target.value })} /></label>
          <label>API Key<input type="password" required={!settings.apiKeyConfigured} value={settings.apiKey} placeholder={settings.apiKeyConfigured ? '已安全保存，留空则不修改' : 'sk-...'} autoComplete="off" onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} /></label>
          <p>远程地址必须使用 HTTPS；API Key 由系统安全存储加密。</p>
          <button className="primary-button" type="submit">保存模型配置</button>
        </form>
        <div className="model-settings">
          <strong>CLI API Key</strong>
          {(['qoder', 'codebuddy'] as CliProviderId[]).map((id) => {
            const configured = cliKeySettings[`${id}Configured`]
            return <label key={id}>{id === 'qoder' ? 'Qoder PAT' : 'CodeBuddy API Key'}<span><input type="password" value={cliKeys[id]} placeholder={configured ? '已安全保存，留空则不修改' : '请输入 Key'} autoComplete="off" onChange={(event) => setCliKeys({ ...cliKeys, [id]: event.target.value })} /><button className="secondary-button" type="button" onClick={() => saveCliKey(id)}>保存</button></span></label>
          })}
          <p>凭据由系统安全存储加密，仅在启动对应 CLI 时传入。</p>
        </div>
        <div className="model-settings">
          <strong>CLI 路径</strong>
          {(['qoder', 'codebuddy'] as CliProviderId[]).map((id) => (
            <label key={id}>
              {id === 'qoder' ? 'Qoder CLI 路径' : 'CodeBuddy CLI 路径'}
              <span>
                <input value={cliPaths[id]} placeholder={id === 'qoder' ? '例如 C:\\nvm4w\\nodejs\\qodercli.cmd' : '例如 C:\\nvm4w\\nodejs\\codebuddy.cmd'} onChange={(event) => setCliPaths({ ...cliPaths, [id]: event.target.value })} />
                <button className="secondary-button" type="button" onClick={() => saveCliPath(id)}>保存</button>
              </span>
            </label>
          ))}
          <p>可填写 CLI 可执行文件或安装目录；留空则自动从 PATH 和常用安装目录检测。</p>
        </div>
        {message && <div className="settings-message" role="status">{message}</div>}
        <div className="setting-section">
          <div className="setting-section-heading"><strong>AI 工具状态</strong><button className="secondary-button" type="button" disabled={refreshing} onClick={refreshProviders}>{refreshing ? '检测中…' : '重新检测'}</button></div>
          {providers.map((item) => (
            <div className="setting-row" key={item.id}>
              <span>
                {item.name}
                <small>{item.version || (item.id === 'local' ? '内置' : item.id === 'custom' ? '未配置' : item.command ? '已检测到命令' : '未在常用安装目录中检测到')}</small>
                {item.command && <small title={item.command}>{item.command}</small>}
              </span>
              <span className={`status-pill ${item.available ? 'ready' : ''}`}>{item.id === 'local' ? '可用' : item.id === 'custom' ? item.available ? '已就绪' : '未配置' : !item.available ? '未检测到 CLI' : item.apiKeyConfigured ? '已就绪' : 'CLI 已检测'}</span>
            </div>
          ))}
        </div>
        <button className="secondary-button dialog-close" onClick={onClose}>完成</button>
      </section>
    </div>
  )
}

export default App
