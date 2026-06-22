import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle,
  Code,
  Copy,
  FileCode,
  FolderOpen,
  Gear,
  Info,
  LockKey,
  Play,
  ShieldCheck,
  Warning,
  X,
} from '@phosphor-icons/react'
import type { CustomModelSettings, Finding, ProjectInfo, ProviderId, ProviderStatus, ScanReport } from '../../main/types'

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
  const [installing, setInstalling] = useState<Extract<ProviderId, 'qoder' | 'codebuddy'> | null>(null)
  const scanRun = useRef(0)

  useEffect(() => {
    window.sensiScan.getProviderStatuses().then(setProviders).catch(() => setProviders([]))
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
              return (
                <div className={`provider-row ${provider === id ? 'selected' : ''}`} key={id}>
                  <button disabled={!available} onClick={() => onProviderChange(id)}>
                    <span className="radio"><span /></span>
                    <span className="provider-icon">{id === 'local' ? <ShieldCheck size={20} /> : <Code size={20} />}</span>
                    <span className="provider-copy">
                      <strong>{status?.name ?? (id === 'custom' ? '自定义模型' : id === 'qoder' ? 'Qoder CLI' : 'CodeBuddy CLI')}</strong>
                      <small>{providerDescriptions[id]}</small>
                    </span>
                    <span className={`status-pill ${available ? 'ready' : ''}`}>{available ? '可用' : id === 'custom' ? '未配置' : '未安装'}</span>
                  </button>
                  {id === 'custom' && !available && <button className="install-link" onClick={onConfigure}>去配置</button>}
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

  function navigate(offset: number): void {
    const next = report.findings[selectedIndex + offset]
    if (next) onSelectFinding(next.id)
  }

  return (
    <section className="results-screen">
      <div className="results-header">
        <div>
          <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> 返回项目</button>
          <h2>{report.project.name} 体检报告</h2>
          <p>已检查 {report.scannedFiles} 个代码文件，用时 {(report.durationMs / 1000).toFixed(1)} 秒</p>
        </div>
        <button className="secondary-button" onClick={() => navigator.clipboard.writeText(JSON.stringify(report, null, 2))}><Copy size={17} /> 复制报告</button>
      </div>

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

function SettingsDialog({ providers, onProvidersChange, onClose }: { providers: ProviderStatus[]; onProvidersChange: (providers: ProviderStatus[]) => void; onClose: () => void }): ReactElement {
  const [settings, setSettings] = useState<CustomModelSettings>({ baseUrl: '', model: '', apiKey: '', apiKeyConfigured: false })
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    window.sensiScan.getCustomModelSettings().then((value) => setSettings({ ...value, apiKey: '' })).catch(() => setMessage('无法读取自定义模型配置。'))
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

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置与隐私" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header"><div><h2>设置与隐私</h2><p>默认设置已经适合大多数项目。</p></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
        <div className="setting-block">
          <LockKey size={22} />
          <div><strong>代码读取范围</strong><p>本地规则只读取所选目录中的源代码文件，不读取 Git 历史，不修改任何文件。</p></div>
        </div>
        <form className="model-settings" onSubmit={saveSettings}>
          <strong>自定义模型</strong>
          <label>Base URL<input type="url" required value={settings.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label>
          <label>Model<input required value={settings.model} placeholder="model-name" onChange={(event) => setSettings({ ...settings, model: event.target.value })} /></label>
          <label>API Key<input type="password" required={!settings.apiKeyConfigured} value={settings.apiKey} placeholder={settings.apiKeyConfigured ? '已安全保存，留空则不修改' : 'sk-...'} autoComplete="off" onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} /></label>
          <p>远程地址必须使用 HTTPS；API Key 由系统安全存储加密。</p>
          {message && <div className="settings-message" role="status">{message}</div>}
          <button className="primary-button" type="submit">保存模型配置</button>
        </form>
        <div className="setting-section">
          <strong>AI 工具状态</strong>
          {providers.map((item) => (
            <div className="setting-row" key={item.id}><span>{item.name}<small>{item.version || (item.id === 'local' ? '内置' : '未检测到命令')}</small></span><span className={`status-pill ${item.available ? 'ready' : ''}`}>{item.available ? '可用' : '未安装'}</span></div>
          ))}
        </div>
        <button className="secondary-button dialog-close" onClick={onClose}>完成</button>
      </section>
    </div>
  )
}

export default App
