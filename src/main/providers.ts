import { execFile, spawn } from 'node:child_process'
import { app, safeStorage } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { CLI_API_KEY_ENV, type CliApiKeySettings, type CliPathSettings, type CliProviderId, type CustomModelSettings, type Finding, type ProviderId, type ProviderStatus } from './types'

const execFileAsync = promisify(execFile)

const PROVIDERS: Record<Exclude<ProviderId, 'local' | 'custom'>, { commands: string[]; helpUrl: string }> = {
  qoder: { commands: ['qodercli'], helpUrl: 'https://qoder.com/cli' },
  codebuddy: { commands: ['codebuddy', 'cbc'], helpUrl: 'https://www.codebuddy.cn/cli/' },
}

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.cmd', '.exe', '.bat']
const DISALLOWED_TOOLS = 'AskUserQuestion,Bash,Edit,MultiEdit,ExitPlanMode,Glob,Grep,LSP,NotebookEdit,Read,Skill,SlashCommand,Task,TaskOutput,TaskCreate,TaskUpdate,TaskList,TaskGet,WebFetch,WebSearch,Write'
const CODEBUDDY_CHINA_ENVIRONMENT = 'internal'
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const PROVIDER_DETAIL_LIMIT = 8000
const PROVIDER_FAILURE_MESSAGE = 'AI 复核失败，已保留本地规则结果。请查看大模型调用日志。'
const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['confirmed', 'suspected', 'safe'] },
          reason: { type: 'string' },
          route: { type: 'string' },
        },
        required: ['id', 'status'],
      },
    },
  },
  required: ['findings'],
}

export function windowsExecutableCandidates(command: string): string[] {
  if (/\.(?:cmd|exe|bat)$/i.test(command)) return [command]
  return [...WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${command}${extension}`), command]
}

export function windowsProviderCommandCandidates(provider: CliProviderId, env: NodeJS.ProcessEnv): string[] {
  const npmCommands = provider === 'qoder' ? ['qodercli.cmd'] : ['codebuddy.cmd', 'cbc.cmd']
  const candidates = npmCommands.map((command) => env.APPDATA && win32.join(env.APPDATA, 'npm', command))
  if (provider === 'codebuddy' && env.LOCALAPPDATA) {
    candidates.push(
      win32.join(env.LOCALAPPDATA, 'codebuddy', 'bin', 'codebuddy.exe'),
      win32.join(env.LOCALAPPDATA, 'codebuddy', 'bin', 'codebuddy.cmd'),
      win32.join(env.LOCALAPPDATA, 'codebuddy', 'bin', 'codebuddy'),
    )
  }
  return [...new Set(candidates.filter((path): path is string => Boolean(path)))]
}

interface ProviderInvocation {
  args: string[]
  input?: string
}

export function providerInvocation(provider: CliProviderId, prompt: string): ProviderInvocation {
  if (provider === 'codebuddy') {
    return {
      args: ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(REVIEW_JSON_SCHEMA), '-y', '--disallowedTools', DISALLOWED_TOOLS],
      input: prompt,
    }
  }
  return { args: ['-p', prompt, '--output-format', 'json', '--disallowed-tools', DISALLOWED_TOOLS] }
}

export function providerArgs(provider: CliProviderId, prompt: string): string[] {
  return providerInvocation(provider, prompt).args
}

interface StoredCustomModelSettings {
  baseUrl: string
  model: string
  encryptedApiKey: string
}

function customModelSettingsPath(): string {
  return join(app.getPath('userData'), 'custom-model.json')
}

function cliApiKeysPath(): string {
  return join(app.getPath('userData'), 'cli-api-keys.json')
}

function cliPathsPath(): string {
  return join(app.getPath('userData'), 'cli-paths.json')
}

async function loadCliApiKeys(): Promise<Partial<Record<CliProviderId, string>>> {
  try {
    return JSON.parse(await readFile(cliApiKeysPath(), 'utf8')) as Partial<Record<CliProviderId, string>>
  } catch {
    return {}
  }
}

export async function getCliApiKeySettings(): Promise<CliApiKeySettings> {
  const stored = await loadCliApiKeys()
  return { qoderConfigured: Boolean(stored.qoder), codebuddyConfigured: Boolean(stored.codebuddy) }
}

async function loadCliPathSettings(): Promise<CliPathSettings> {
  try {
    const stored = JSON.parse(await readFile(cliPathsPath(), 'utf8')) as Partial<CliPathSettings>
    return { qoder: stored.qoder?.trim() ?? '', codebuddy: stored.codebuddy?.trim() ?? '' }
  } catch {
    return { qoder: '', codebuddy: '' }
  }
}

export async function getCliPathSettings(): Promise<CliPathSettings> {
  return loadCliPathSettings()
}

export async function saveCliPath(provider: CliProviderId, cliPath: string): Promise<CliPathSettings> {
  if (!['qoder', 'codebuddy'].includes(provider)) throw new Error('不支持该 AI 工具')
  const stored = await loadCliPathSettings()
  stored[provider] = cliPath.trim()
  const path = cliPathsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  return stored
}

export async function saveCliApiKey(provider: CliProviderId, apiKey: string): Promise<CliApiKeySettings> {
  if (!['qoder', 'codebuddy'].includes(provider)) throw new Error('不支持该 AI 工具')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API Key')
  const stored = await loadCliApiKeys()
  if (apiKey.trim()) stored[provider] = safeStorage.encryptString(apiKey.trim()).toString('base64')
  if (!stored[provider]) throw new Error('请填写 API Key')
  const path = cliApiKeysPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  return getCliApiKeySettings()
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function commandPathCandidates(provider: CliProviderId, customPath: string): string[] {
  const trimmed = customPath.trim()
  if (!trimmed) return []
  const commands = PROVIDERS[provider].commands
  if (isDirectory(trimmed)) {
    return process.platform === 'win32'
      ? commands.flatMap((command) => windowsExecutableCandidates(win32.join(trimmed, command)))
      : commands.map((command) => join(trimmed, command))
  }
  return process.platform === 'win32' ? windowsExecutableCandidates(trimmed) : [trimmed]
}

function providerCommandNames(commands: string[]): string[] {
  return process.platform === 'win32' ? commands.flatMap(windowsExecutableCandidates) : commands
}

async function locateCommand(command: string): Promise<string | undefined> {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(locator, [command], { timeout: 3000 })
    const located = stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean)
    if (process.platform !== 'win32') return located[0]
    for (const path of located) {
      const executable = windowsExecutableCandidates(path).find(existsSync)
      if (executable) return executable
    }
  } catch {
    return undefined
  }
  return undefined
}

async function resolveCommand(provider: CliProviderId, commands: string[], customPath: string): Promise<{ command?: string; searchedPaths: string[] }> {
  const customCandidates = commandPathCandidates(provider, customPath)
  const searchedPaths = customCandidates.length > 0 ? [...customCandidates] : []
  const customCommand = customCandidates.find(existsSync)
  if (customCommand) return { command: customCommand, searchedPaths }

  const commandNames = providerCommandNames(commands)
  searchedPaths.push(...commandNames.map((command) => `PATH:${command}`))
  for (const command of commandNames) {
    const located = await locateCommand(command)
    if (located) return { command: located, searchedPaths }
  }

  if (process.platform === 'win32') {
    const candidates = windowsProviderCommandCandidates(provider, process.env)
    searchedPaths.push(...candidates)
    return { command: candidates.find(existsSync), searchedPaths }
  }
  return { searchedPaths }
}

async function readVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], { timeout: 5000, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command), windowsHide: true })
    return (stdout || stderr).trim().split(/\r?\n/)[0]
  } catch {
    return undefined
  }
}

export async function getProviderStatuses(): Promise<ProviderStatus[]> {
  const local: ProviderStatus = { id: 'local', name: '本地规则', available: true }
  const customSettings = await getCustomModelSettings()
  const cliApiKeys = await getCliApiKeySettings()
  const cliPaths = await getCliPathSettings()
  const custom: ProviderStatus = { id: 'custom', name: '自定义模型', available: customSettings.apiKeyConfigured && Boolean(customSettings.baseUrl && customSettings.model) }
  const external = await Promise.all(
    (Object.entries(PROVIDERS) as [Exclude<ProviderId, 'local' | 'custom'>, (typeof PROVIDERS)['qoder']][]).map(async ([id, config]) => {
      const { command, searchedPaths } = await resolveCommand(id, config.commands, cliPaths[id])
      return {
        id,
        name: id === 'qoder' ? 'Qoder CLI' : 'CodeBuddy CLI',
        available: Boolean(command),
        command,
        version: command ? await readVersion(command) : undefined,
        helpUrl: config.helpUrl,
        apiKeyConfigured: cliApiKeys[`${id}Configured`],
        searchedPaths,
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
不要输出解释、前缀、后缀或代码块；最终内容必须只包含上述 JSON 对象。

候选问题：${JSON.stringify(findings.slice(0, 40))}`
}

export class ProviderReviewError extends Error {
  details?: string

  constructor(message: string, details?: string) {
    super(message)
    this.name = 'ProviderReviewError'
    this.details = details
  }
}

function redactProviderSecrets(input: string): string {
  return input
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b((?:CODEBUDDY_API_KEY|QODER_PERSONAL_ACCESS_TOKEN|api[_-]?key|token|authorization)\s*[:=]\s*)[^\s"'，,;]+/gi, '$1[REDACTED]')
}

function cleanProviderDetail(input: string): string | undefined {
  const cleaned = redactProviderSecrets(input)
    .replace(ANSI_ESCAPE_PATTERN, ' ')
    .replace(CONTROL_CHARACTER_PATTERN, ' ')
    .replace(/\p{M}+/gu, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned.slice(0, PROVIDER_DETAIL_LIMIT) : undefined
}

export function providerReviewError(message: string, sections: [string, string | number | undefined][]): ProviderReviewError {
  const details = sections
    .map(([label, value]) => {
      if (value === undefined || value === '') return undefined
      const cleaned = cleanProviderDetail(String(value))
      if (!cleaned) return undefined
      return cleaned.includes('\n') ? `${label}:\n${cleaned}` : `${label}: ${cleaned}`
    })
    .filter((value): value is string => Boolean(value))
    .join('\n\n')
  return new ProviderReviewError(message, details || undefined)
}

function assertProviderOutputLooksJson(output: string): void {
  const readable = cleanProviderMessage(output) ?? output
  if (/authentication required|please use \/login|sign in to your account/i.test(readable)) {
    throw providerReviewError('CodeBuddy 认证失败：请确认 API Key 有效，并已配置中国版环境 CODEBUDDY_INTERNET_ENVIRONMENT=internal。', [['output', output]])
  }
}

function parseJsonCandidate(input: string): unknown {
  const trimmed = input.trim()
  assertProviderOutputLooksJson(trimmed)
  try {
    return JSON.parse(trimmed)
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
    if (fenced) return parseJsonCandidate(fenced)
    const arrayStart = trimmed.indexOf('[')
    const arrayEnd = trimmed.lastIndexOf(']')
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try {
        return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1))
      } catch {
        // Some CLIs print log lines before a JSON object; keep trying below.
      }
    }
    const objectStart = trimmed.indexOf('{')
    const objectEnd = trimmed.lastIndexOf('}')
    if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(trimmed.slice(objectStart, objectEnd + 1))
    throw providerReviewError(PROVIDER_FAILURE_MESSAGE, [['parseError', 'AI 返回内容不是有效 JSON'], ['output', input]])
  }
}

export function unwrapProviderOutput(output: string): unknown {
  const trimmed = output.trim()
  const parsed = parseJsonCandidate(trimmed)
  if (Array.isArray(parsed)) {
    for (const item of [...parsed].reverse()) {
      const unwrapped = unwrapKnownProviderPayload(item)
      if (unwrapped) return unwrapped
    }
    return parsed
  }
  return unwrapKnownProviderPayload(parsed) ?? parsed
}

function unwrapKnownProviderPayload(parsed: unknown): unknown | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const payload = parsed as Record<string, unknown>
  if (payload.findings) return payload
  for (const key of ['structured_output', 'result', 'response', 'content']) {
    const value = payload[key]
    if (typeof value === 'string') return unwrapProviderOutput(value)
    if (value && typeof value === 'object') return value
  }
  return undefined
}

function decodeText(buffer: Buffer, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding).decode(buffer)
  } catch {
    return undefined
  }
}

function outputNoiseScore(text: string): number {
  const replacementCharacters = text.match(/\uFFFD/g)?.length ?? 0
  const controlCharacters = text.match(CONTROL_CHARACTER_PATTERN)?.length ?? 0
  const combiningMarks = text.match(/\p{M}/gu)?.length ?? 0
  return replacementCharacters * 10 + controlCharacters * 4 + combiningMarks
}

export function decodeProviderOutput(chunks: Buffer[]): string {
  const buffer = Buffer.concat(chunks)
  if (buffer.length === 0) return ''
  const utf8 = decodeText(buffer, 'utf-8') ?? buffer.toString('utf8')
  const gb18030 = decodeText(buffer, 'gb18030')
  return gb18030 && outputNoiseScore(gb18030) < outputNoiseScore(utf8) ? gb18030 : utf8
}

export function cleanProviderMessage(input: string): string | undefined {
  const cleaned = input
    .replace(ANSI_ESCAPE_PATTERN, ' ')
    .replace(CONTROL_CHARACTER_PATTERN, ' ')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : undefined
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const timeout = setTimeout(() => child.kill(), 5 * 60 * 1000)
    child.stdout.on('data', (chunk: Buffer) => { stdoutChunks.push(Buffer.from(chunk)) })
    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(Buffer.from(chunk)) })
    child.stdin.end(input ?? '')
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timeout)
      const stdout = decodeProviderOutput(stdoutChunks)
      const stderr = decodeProviderOutput(stderrChunks)
      if (code === 0) resolve(stdout)
      else reject(providerReviewError(PROVIDER_FAILURE_MESSAGE, [
        ['exitCode', code ?? 'unknown'],
        ['stderr', stderr],
        ['stdout', stdout],
      ]))
    })
  })
}

function providerEnv(provider: CliProviderId, apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  if (apiKey) env[CLI_API_KEY_ENV[provider]] = apiKey
  if (provider === 'codebuddy' && !env.CODEBUDDY_INTERNET_ENVIRONMENT) {
    env.CODEBUDDY_INTERNET_ENVIRONMENT = CODEBUDDY_CHINA_ENVIRONMENT
  }
  return env
}

export async function reviewWithProvider(provider: Exclude<ProviderId, 'local' | 'custom'>, root: string, findings: Finding[]): Promise<Finding[]> {
  if (findings.length === 0) return findings
  const status = (await getProviderStatuses()).find((item) => item.id === provider)
  if (!status?.command) throw new Error(`${status?.name ?? provider} 未检测到。已检查：${status?.searchedPaths?.join('、') ?? '系统 PATH'}`)
  const stored = await loadCliApiKeys()
  const encryptedApiKey = stored[provider]
  if (encryptedApiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 API Key')
  const apiKey = encryptedApiKey ? safeStorage.decryptString(Buffer.from(encryptedApiKey, 'base64')) : undefined
  const prompt = createPrompt(findings)
  const invocation = providerInvocation(provider, prompt)
  const output = await run(status.command, invocation.args, root, providerEnv(provider, apiKey), invocation.input)
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
