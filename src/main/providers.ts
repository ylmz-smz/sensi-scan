import { execFile, spawn } from 'node:child_process'
import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { CustomModelSettings, Finding, ProviderId, ProviderStatus } from './types'

const execFileAsync = promisify(execFile)

const PROVIDERS: Record<Exclude<ProviderId, 'local' | 'custom'>, { commands: string[]; helpUrl: string }> = {
  qoder: { commands: ['qodercli'], helpUrl: 'https://qoder.com/cli' },
  codebuddy: { commands: ['codebuddy', 'cbc'], helpUrl: 'https://www.codebuddy.cn/cli/' },
}

interface StoredCustomModelSettings {
  baseUrl: string
  model: string
  encryptedApiKey: string
}

function customModelSettingsPath(): string {
  return join(app.getPath('userData'), 'custom-model.json')
}

async function loadStoredCustomModelSettings(): Promise<StoredCustomModelSettings | null> {
  try {
    return JSON.parse(await readFile(customModelSettingsPath(), 'utf8')) as StoredCustomModelSettings
  } catch {
    return null
  }
}

function decryptApiKey(settings: StoredCustomModelSettings): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 API Key')
  return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64'))
}

export async function getCustomModelSettings(): Promise<CustomModelSettings> {
  const stored = await loadStoredCustomModelSettings()
  return {
    baseUrl: stored?.baseUrl ?? '',
    model: stored?.model ?? '',
    apiKeyConfigured: Boolean(stored?.encryptedApiKey),
  }
}

export async function saveCustomModelSettings(settings: Omit<CustomModelSettings, 'apiKeyConfigured'>): Promise<CustomModelSettings> {
  const baseUrl = settings.baseUrl.trim()
  const model = settings.model.trim()
  const url = new URL(baseUrl)
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('远程模型地址必须使用 HTTPS')
  if (!model) throw new Error('请填写模型名称')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API Key')

  const existing = await loadStoredCustomModelSettings()
  const encryptedApiKey = settings.apiKey?.trim()
    ? safeStorage.encryptString(settings.apiKey.trim()).toString('base64')
    : existing?.encryptedApiKey
  if (!encryptedApiKey) throw new Error('请填写 API Key')

  const path = customModelSettingsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ baseUrl, model, encryptedApiKey }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return { baseUrl, model, apiKeyConfigured: true }
}

async function resolveCommand(commands: string[]): Promise<string | undefined> {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(locator, [command], { timeout: 3000 })
      if (stdout.trim()) return command
    } catch {
      // Try the next supported executable name.
    }
  }
  return undefined
}

async function readVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], { timeout: 5000 })
    return (stdout || stderr).trim().split(/\r?\n/)[0]
  } catch {
    return undefined
  }
}

export async function getProviderStatuses(): Promise<ProviderStatus[]> {
  const local: ProviderStatus = { id: 'local', name: '本地规则', available: true }
  const customSettings = await getCustomModelSettings()
  const custom: ProviderStatus = { id: 'custom', name: '自定义模型', available: customSettings.apiKeyConfigured && Boolean(customSettings.baseUrl && customSettings.model) }
  const external = await Promise.all(
    (Object.entries(PROVIDERS) as [Exclude<ProviderId, 'local' | 'custom'>, (typeof PROVIDERS)['qoder']][]).map(async ([id, config]) => {
      const command = await resolveCommand(config.commands)
      return {
        id,
        name: id === 'qoder' ? 'Qoder CLI' : 'CodeBuddy CLI',
        available: Boolean(command),
        command,
        version: command ? await readVersion(command) : undefined,
        helpUrl: config.helpUrl,
      }
    }),
  )
  return [local, custom, ...external]
}

function createPrompt(findings: Finding[]): string {
  return `你是敏感信息展示审查员。请只复核下面由本地规则发现的候选问题，不要修改文件、不要执行命令、不要访问网络。
判断每项是否确实存在未脱敏展示风险。仅返回 JSON，不要包含 Markdown。格式：
{"findings":[{"id":"原始ID","status":"confirmed|suspected|safe","reason":"简短中文理由","route":"有证据的页面路由或待确认"}]}
无法确认页面权限、完整数据流或页面路由时必须使用 suspected，不要编造路由。

候选问题：${JSON.stringify(findings.slice(0, 40))}`
}

function unwrapProviderOutput(output: string): unknown {
  const trimmed = output.trim()
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof parsed.result === 'string') return JSON.parse(parsed.result)
    if (parsed.structured_output) return parsed.structured_output
    return parsed
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error('AI 返回内容不是有效 JSON')
  }
}

function run(command: string, args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => child.kill(), 5 * 60 * 1000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdin.end(input)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${command} 退出码：${code}`))
    })
  })
}

export async function reviewWithProvider(provider: Exclude<ProviderId, 'local' | 'custom'>, root: string, findings: Finding[]): Promise<Finding[]> {
  if (findings.length === 0) return findings
  const status = (await getProviderStatuses()).find((item) => item.id === provider)
  if (!status?.command) throw new Error(`${status?.name ?? provider} 尚未安装`)
  const args = ['-p', '--input-format', 'text', '--output-format', 'json', '--tools', '']
  const output = await run(status.command, args, root, createPrompt(findings))
  return applyReviews(findings, output)
}

function applyReviews(findings: Finding[], output: string): Finding[] {
  const parsed = unwrapProviderOutput(output) as { findings?: { id: string; status: Finding['status']; reason?: string; route?: string }[] }
  const reviews = new Map((parsed.findings ?? []).filter((item) => ['confirmed', 'suspected', 'safe'].includes(item.status)).map((item) => [item.id, item]))
  return findings.map((finding) => {
    const review = reviews.get(finding.id)
    return review ? { ...finding, status: review.status, reason: review.reason?.slice(0, 500) || finding.reason, route: review.route?.slice(0, 300) || finding.route } : finding
  })
}

export async function reviewWithCustomModel(findings: Finding[]): Promise<Finding[]> {
  if (findings.length === 0) return findings
  const stored = await loadStoredCustomModelSettings()
  if (!stored) throw new Error('自定义模型尚未配置')
  const apiKey = decryptApiKey(stored)
  const base = stored.baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: stored.model, temperature: 0, messages: [{ role: 'user', content: createPrompt(findings) }] }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  })
  if (!response.ok) throw new Error(`自定义模型请求失败：HTTP ${response.status}`)
  const body = await response.json() as { choices?: { message?: { content?: string } }[] }
  const output = body.choices?.[0]?.message?.content
  if (!output) throw new Error('自定义模型未返回有效内容')
  return applyReviews(findings, output)
}
