import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { read } from 'xlsx'
import { inspectProject, scanProject } from '../src/main/scanner'
import { nodeArchive, providerInstallArgs, windowsNodeCandidates } from '../src/main/installer'
import { CLI_API_KEY_ENV } from '../src/main/types'
import { scanReportToExcel, scanReportToMarkdown } from '../src/main/report'
import { cleanProviderMessage, decodeProviderOutput, providerArgs, providerInvocation, providerReviewError, unwrapProviderOutput, windowsExecutableCandidates, windowsProviderCommandCandidates } from '../src/main/providers'
import { compileRuleConfigs, defaultRuleConfigs, loadRuleConfigState, loadRuleConfigs, validateRuleConfigs } from '../src/main/rules'

test('生成官方 CLI 安装参数并定位 Windows Node.js', () => {
  assert.deepEqual(providerInstallArgs('qoder'), ['install', '-g', '@qoder-ai/qodercli@latest'])
  assert.deepEqual(providerInstallArgs('codebuddy'), ['install', '-g', '@tencent-ai/codebuddy-code@latest'])
  assert.deepEqual(windowsNodeCandidates({ ProgramFiles: 'C:\\Program Files' }), ['C:\\Program Files\\nodejs\\node.exe'])
  assert.deepEqual(CLI_API_KEY_ENV, { qoder: 'QODER_PERSONAL_ACCESS_TOKEN', codebuddy: 'CODEBUDDY_API_KEY' })
})

test('定位 Windows CLI 并使用各自的非交互参数', () => {
  assert.deepEqual(windowsExecutableCandidates('C:\\nvm4w\\nodejs\\qodercli'), [
    'C:\\nvm4w\\nodejs\\qodercli.cmd',
    'C:\\nvm4w\\nodejs\\qodercli.exe',
    'C:\\nvm4w\\nodejs\\qodercli.bat',
    'C:\\nvm4w\\nodejs\\qodercli',
  ])
  assert.deepEqual(windowsProviderCommandCandidates('qoder', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }), [
    'C:\\Users\\me\\AppData\\Roaming\\npm\\qodercli.cmd',
  ])
  assert.deepEqual(windowsProviderCommandCandidates('codebuddy', {
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  }), [
    'C:\\Users\\me\\AppData\\Roaming\\npm\\codebuddy.cmd',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\cbc.cmd',
    'C:\\Users\\me\\AppData\\Local\\codebuddy\\bin\\codebuddy.exe',
    'C:\\Users\\me\\AppData\\Local\\codebuddy\\bin\\codebuddy.cmd',
    'C:\\Users\\me\\AppData\\Local\\codebuddy\\bin\\codebuddy',
  ])
  const prompt = '{"findings":[]}'
  assert.deepEqual(providerArgs('qoder', prompt).slice(0, 4), ['-p', prompt, '--output-format', 'json'])
  assert.ok(providerArgs('qoder', prompt).includes('--disallowed-tools'))
  const longPrompt = 'x'.repeat(9000)
  assert.deepEqual(providerArgs('codebuddy', longPrompt).slice(0, 3), ['-p', '--output-format', 'json'])
  assert.ok(!providerArgs('codebuddy', longPrompt).includes(longPrompt))
  assert.equal(providerInvocation('codebuddy', longPrompt).input, longPrompt)
  assert.ok(providerArgs('codebuddy', longPrompt).includes('--json-schema'))
  assert.ok(providerArgs('codebuddy', longPrompt).includes('-y'))
  assert.ok(providerArgs('codebuddy', longPrompt).includes('--disallowedTools'))
})

test('解析 CLI 外层 JSON 并提取复核结果', () => {
  assert.deepEqual(unwrapProviderOutput('{"result":"{\\"findings\\":[{\\"id\\":\\"1\\",\\"status\\":\\"safe\\"}]}"}'), {
    findings: [{ id: '1', status: 'safe' }],
  })
  assert.deepEqual(unwrapProviderOutput('{"response":"```json\\n{\\"findings\\":[{\\"id\\":\\"2\\",\\"status\\":\\"confirmed\\"}]}\\n```"}'), {
    findings: [{ id: '2', status: 'confirmed' }],
  })
  assert.deepEqual(unwrapProviderOutput('[{"type":"metadata"},{"response":"{\\"findings\\":[{\\"id\\":\\"3\\",\\"status\\":\\"suspected\\"}]}"}]'), {
    findings: [{ id: '3', status: 'suspected' }],
  })
  assert.deepEqual(unwrapProviderOutput('{"structured_output":{"findings":[{"id":"4","status":"safe"}]}}'), {
    findings: [{ id: '4', status: 'safe' }],
  })
  assert.deepEqual(unwrapProviderOutput('{"structured_output":"{\\"findings\\":[{\\"id\\":\\"5\\",\\"status\\":\\"confirmed\\"}]}"}'), {
    findings: [{ id: '5', status: 'confirmed' }],
  })
  assert.throws(
    () => unwrapProviderOutput('Authentication required. Please use /login command to sign in to your account'),
    /CodeBuddy 认证失败/,
  )
})

test('清洗 Windows CLI 输出并避免乱码污染复核日志', () => {
  const gbkFailure = Buffer.from([
    ...Buffer.from('CodeBuddy '),
    0xca, 0xa7, 0xb0, 0xdc, 0xa3, 0xba, 0xc7, 0xeb, 0xb5, 0xc7, 0xc2, 0xbc,
  ])

  assert.equal(decodeProviderOutput([gbkFailure]), 'CodeBuddy 失败：请登录')
  assert.equal(cleanProviderMessage('\x1b[31m      \u032b    \x1b[0m'), undefined)
  assert.equal(cleanProviderMessage('\x1b[31mAuthentication required\x1b[0m'), 'Authentication required')
})

test('复核失败日志保留可读详情并脱敏', () => {
  const error = providerReviewError(
    'AI 复核失败，已保留本地规则结果。请查看大模型调用日志。',
    [
      ['exitCode', '1'],
      ['stderr', 'CODEBUDDY_API_KEY=secret-token\nAuthentication required'],
      ['stdout', '\x1b[31m      \u032b    \x1b[0m'],
    ],
  )

  assert.equal(error.message, 'AI 复核失败，已保留本地规则结果。请查看大模型调用日志。')
  assert.ok(error.details)
  assert.match(error.details, /exitCode: 1/)
  assert.match(error.details, /stderr:/)
  assert.match(error.details, /Authentication required/)
  assert.doesNotMatch(error.details, /secret-token/)
  assert.doesNotMatch(error.details, /\u032b/)
})

test('从官方校验清单选择当前 Mac 架构的 Node.js', () => {
  const checksum = 'a'.repeat(64)
  assert.deepEqual(nodeArchive(`${checksum}  node-v22.23.0-darwin-arm64.tar.gz`, 'arm64'), {
    checksum,
    filename: 'node-v22.23.0-darwin-arm64.tar.gz',
  })
  assert.throws(() => nodeArchive('bad manifest', 'arm64'))
})

test('识别技术栈并报告未脱敏手机号展示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sensi-scan-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'User.tsx'), `
    export function User({ phone }: { phone: string }) {
      return <span>{phone}</span>
    }
  `)

  const project = await inspectProject(root)
  const result = await scanProject(root)

  assert.equal(project.files, 1)
  assert.ok(project.technologies.includes('React'))
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].sensitiveType, '手机号')
  assert.equal(result.findings[0].route, '待确认')
})

test('跳过已经脱敏的展示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sensi-scan-'))
  await writeFile(join(root, 'User.vue'), '<span>{{ maskPhone(phone) }}</span>')

  const result = await scanProject(root)

  assert.equal(result.findings.length, 0)
})

test('从路由配置补充页面路由', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sensi-scan-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'UserPage.tsx'), 'export const UserPage = ({ phone }: { phone: string }) => <span>{phone}</span>')
  await writeFile(join(root, 'src', 'router.tsx'), '<Route path="/users" element={<UserPage />} />')

  const result = await scanProject(root)

  assert.equal(result.findings[0].route, '/users')
})

test('扫描使用修改后的字段关键词', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sensi-scan-'))
  await writeFile(join(root, 'User.tsx'), 'export const User = ({ contactPhone }: { contactPhone: string }) => <span>{contactPhone}</span>')
  const rules = compileRuleConfigs([{
    id: 'phone',
    type: '手机号',
    keywords: ['contactPhone'],
    severity: 'medium',
    suggestion: '展示前三后四。',
    enabled: true,
  }])

  const result = await scanProject(root, rules)

  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].sensitiveType, '手机号')
})

test('禁用字段规则后扫描不再命中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sensi-scan-'))
  await writeFile(join(root, 'User.tsx'), 'export const User = ({ phone }: { phone: string }) => <span>{phone}</span>')

  const result = await scanProject(root, [])

  assert.equal(result.findings.length, 0)
})

test('导出可读的 Markdown 报告', () => {
  const markdown = scanReportToMarkdown({
    project: { path: '/project', name: 'demo', files: 1, technologies: ['React'] },
    provider: 'local',
    startedAt: '2026-06-22T00:00:00.000Z',
    durationMs: 1200,
    scannedFiles: 1,
    findings: [{
      id: '1', severity: 'high', status: 'confirmed', sensitiveType: '手机号', title: '手机号完整展示',
      reason: '未发现脱敏。', file: 'src/User.tsx', line: 3, snippet: '<span>{phone}</span>',
      route: '/users', api: '/api/users', suggestion: '展示前三后四。',
    }],
  })

  assert.match(markdown, /^# demo 敏感信息体检报告/m)
  assert.match(markdown, /## 1\. 手机号完整展示/)
  assert.match(markdown, /代码位置：src\/User\.tsx:3/)
})

test('导出 Excel 使用固定表头并按状态排序', () => {
  const buffer = scanReportToExcel({
    project: { path: '/project', name: 'demo', files: 1, technologies: ['React'] },
    provider: 'local',
    startedAt: '2026-06-22T00:00:00.000Z',
    durationMs: 1200,
    scannedFiles: 1,
    findings: [
      { id: 'safe', severity: 'low', status: 'safe', sensitiveType: '邮箱', title: '邮箱展示', reason: '合理展示。', file: 'src/Safe.tsx', line: 1, snippet: 'email', route: '/safe', api: '待确认', suggestion: '无。' },
      { id: 'confirmed', severity: 'high', status: 'confirmed', sensitiveType: '手机号', title: '手机号完整展示', reason: '未脱敏。', file: 'src/User.tsx', line: 3, snippet: 'phone', route: '/users', api: '/api/users', suggestion: '展示前三后四。' },
      { id: 'suspected', severity: 'medium', status: 'suspected', sensitiveType: '地址', title: '地址展示', reason: '待确认。', file: 'src/Address.tsx', line: 2, snippet: 'address', route: '待确认', api: '待确认', suggestion: '隐藏详细地址。' },
    ],
  })
  const workbook = read(buffer)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]

  assert.equal(sheet.A1.v, '问题')
  assert.equal(sheet.B1.v, '风险等级')
  assert.equal(sheet.C1.v, '状态')
  assert.equal(sheet.D1.v, '敏感信息')
  assert.equal(sheet.E1.v, '路由')
  assert.equal(sheet.F1.v, '接口路径')
  assert.equal(sheet.G1.v, '代码位置')
  assert.equal(sheet.A2.v, '地址展示')
  assert.equal(sheet.C2.v, '待确认')
  assert.equal(sheet.A3.v, '手机号完整展示')
  assert.equal(sheet.C3.v, '已确认')
  assert.equal(sheet.A4.v, '邮箱展示')
  assert.equal(sheet.C4.v, '合理展示')
})

test('默认字段规则作为可编辑配置加载', () => {
  const phone = defaultRuleConfigs.find((rule) => rule.type === '手机号')

  assert.ok(phone)
  assert.equal(phone.enabled, true)
  assert.ok(phone.keywords.includes('phone'))
  assert.equal(phone.severity, 'medium')
})

test('校验字段规则并清理重复关键词', () => {
  const configs = validateRuleConfigs([{
    id: 'custom-phone',
    type: '手机号',
    keywords: [' phone ', 'phone', 'mobileNo'],
    severity: 'medium',
    suggestion: '展示前三后四。',
    enabled: true,
  }])

  assert.deepEqual(configs[0].keywords, ['phone', 'mobileNo'])
})

test('字段规则编译时跳过禁用项', () => {
  const rules = compileRuleConfigs([
    {
      id: 'disabled-phone',
      type: '手机号',
      keywords: ['phone'],
      severity: 'medium',
      suggestion: '展示前三后四。',
      enabled: false,
    },
  ])

  assert.equal(rules.length, 0)
})

test('字段规则支持中文关键词并保留 ASCII 单词边界', () => {
  const rules = compileRuleConfigs([
    {
      id: 'name',
      type: '姓名',
      keywords: ['姓名', 'name'],
      severity: 'low',
      suggestion: '部分展示。',
      enabled: true,
    },
  ])

  assert.match('const label = "姓名"', rules[0].pattern)
  assert.match('const name = user.name', rules[0].pattern)
  assert.doesNotMatch('const username = user.username', rules[0].pattern)
})

test('字段规则设置读取会区分缺失配置和损坏配置', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'sensi-scan-rules-'))
  const rulesPath = join(userData, 'field-rules.json')

  const missing = await loadRuleConfigState(rulesPath)
  assert.equal(missing.usingDefaults, true)
  assert.equal(missing.error, undefined)

  await writeFile(rulesPath, '{ bad json', 'utf8')
  const invalid = await loadRuleConfigState(rulesPath)
  assert.equal(invalid.usingDefaults, true)
  assert.match(invalid.error ?? '', /字段检测规则读取失败/)
  assert.deepEqual(invalid.configs, defaultRuleConfigs)

  await rm(userData, { recursive: true, force: true })
})

test('默认字段规则加载结果不会污染后续默认输出', async () => {
  const loaded = await loadRuleConfigs()
  loaded[0].keywords.push('pollutedField')
  loaded[0].enabled = false

  const reloaded = await loadRuleConfigs()
  const phone = reloaded.find((rule) => rule.id === 'phone')

  assert.ok(phone)
  assert.equal(phone.enabled, true)
  assert.ok(!phone.keywords.includes('pollutedField'))
})

test('字段规则 ID 不能重复', () => {
  assert.throws(
    () => validateRuleConfigs([
      {
        id: 'phone',
        type: '手机号',
        keywords: ['phone'],
        severity: 'medium',
        suggestion: '展示前三后四。',
        enabled: true,
      },
      {
        id: 'phone',
        type: '邮箱',
        keywords: ['email'],
        severity: 'low',
        suggestion: '隐藏邮箱用户名中段。',
        enabled: true,
      },
    ]),
    /规则 ID 不能重复/,
  )
})
