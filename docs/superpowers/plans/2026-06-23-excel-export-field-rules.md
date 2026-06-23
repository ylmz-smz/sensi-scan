# Excel Export And Field Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `.xlsx` report export and editable sensitive field detection rules seeded from the current defaults.

**Architecture:** Keep scanning, report generation, and renderer UI separated. Main process owns rule persistence and export file generation; renderer only edits serializable rule configs through preload IPC. Scanner consumes compiled rules, not UI state.

**Tech Stack:** Electron, React, TypeScript, `node:test`, SheetJS `xlsx` installed through `pnpm add xlsx`.

## Global Constraints

- Existing Markdown export must continue working.
- Excel columns must be exactly: 问题、风险等级、状态、敏感信息、路由、接口路径、代码位置.
- Excel rows must sort by status: 待确认, 已确认, 合理展示.
- Current default detection rules must be editable, not read-only.
- Users can add, delete, enable, disable, edit, and reset field rules.
- Users must not enter raw regex.
- Configuration is stored in Electron `userData`, not in scanned projects.
- The scanner must stay read-only for selected code directories.
- Use `rtk` for shell commands in this repository.
- Do not commit unless the user explicitly asks.

---

## File Structure

- Create `src/main/rules.ts`: default rule configs, validation, persistence, keyword-to-regex compilation.
- Modify `src/main/types.ts`: add `SensitiveFieldRuleConfig`, `ReportExportFormat`, and rule API types.
- Modify `src/main/scanner.ts`: remove private hard-coded `RULES` usage and accept compiled rules.
- Modify `src/main/index.ts`: add rule IPC handlers, pass rules into scans, support Excel export format.
- Modify `src/main/report.ts`: add Excel export buffer generation and status sorting.
- Modify `src/preload/index.ts`: expose rule config methods and typed report export format.
- Modify `src/renderer/src/env.d.ts`: pick up preload type changes if needed by existing pattern.
- Modify `src/renderer/src/App.tsx`: add Excel button and field rule editor in settings dialog.
- Modify `package.json` and `pnpm-lock.yaml`: add `xlsx`.
- Modify `tests/scanner.test.ts`: cover rules and Excel export behavior.

### Task 1: Rule Configuration Model And Persistence

**Files:**
- Create: `src/main/rules.ts`
- Modify: `src/main/types.ts`
- Test: `tests/scanner.test.ts`

**Interfaces:**
- Produces: `SensitiveFieldRuleConfig`, `CompiledSensitiveRule`, `defaultRuleConfigs`, `loadRuleConfigs()`, `saveRuleConfigs(configs)`, `resetRuleConfigs()`, `compileRuleConfigs(configs)`.
- Consumes: existing `Severity` type from `src/main/types.ts`.

- [ ] **Step 1: Add failing tests for default editable rule config**

Add this import at the top of `tests/scanner.test.ts` with the existing imports:

```ts
import { compileRuleConfigs, defaultRuleConfigs, validateRuleConfigs } from '../src/main/rules'
```

Append these tests to `tests/scanner.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `rtk pnpm test`

Expected: FAIL because `../src/main/rules` and exported symbols do not exist.

- [ ] **Step 3: Add shared types**

In `src/main/types.ts`, add after `FindingStatus`:

```ts
export interface SensitiveFieldRuleConfig {
  id: string
  type: string
  keywords: string[]
  severity: Severity
  suggestion: string
  enabled: boolean
}

export interface CompiledSensitiveRule {
  type: string
  pattern: RegExp
  severity: Severity
  suggestion: string
}

export type ReportExportFormat = 'markdown' | 'excel'
```

- [ ] **Step 4: Implement rule persistence module**

Create `src/main/rules.ts`:

```ts
import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CompiledSensitiveRule, SensitiveFieldRuleConfig, Severity } from './types'

const severityValues = new Set<Severity>(['high', 'medium', 'low'])

export const defaultRuleConfigs: SensitiveFieldRuleConfig[] = [
  { id: 'phone', type: '手机号', keywords: ['phone', 'mobile', 'phoneNumber', 'mobileNo', 'tel'], severity: 'medium', suggestion: '默认展示前三后四，例如 133****3333。', enabled: true },
  { id: 'id-card', type: '身份证号', keywords: ['idCard', 'identityCard', 'idNumber', 'certNo', 'certificateNo'], severity: 'high', suggestion: '仅保留必要的首尾字符，其余使用星号遮盖。', enabled: true },
  { id: 'bank-card', type: '银行卡号', keywords: ['bankCard', 'cardNumber', 'bankAccount', 'accountNo'], severity: 'high', suggestion: '默认仅展示末四位，完整信息仅在明确授权场景提供。', enabled: true },
  { id: 'email', type: '邮箱', keywords: ['email', 'mailAddress'], severity: 'low', suggestion: '隐藏邮箱用户名中段，并确认页面访问权限。', enabled: true },
  { id: 'address', type: '地址', keywords: ['address', 'homeAddress', 'detailAddress', 'receiverAddress'], severity: 'medium', suggestion: '按业务需要隐藏门牌号或详细地址，并限制导出权限。', enabled: true },
  { id: 'name', type: '姓名', keywords: ['realName', 'fullName', 'userName', 'customerName'], severity: 'low', suggestion: '根据业务角色展示姓氏或部分姓名。', enabled: true },
]

function rulesPath(): string {
  return join(app.getPath('userData'), 'field-rules.json')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeRuleConfig(rule: SensitiveFieldRuleConfig): SensitiveFieldRuleConfig {
  const keywords = [...new Set(rule.keywords.map((keyword) => keyword.trim()).filter(Boolean))]
  if (!rule.id.trim()) throw new Error('规则 ID 不能为空')
  if (!rule.type.trim()) throw new Error('字段类型不能为空')
  if (keywords.length === 0) throw new Error(`${rule.type} 至少需要一个字段关键词`)
  if (!severityValues.has(rule.severity)) throw new Error(`${rule.type} 的风险等级无效`)
  return {
    id: rule.id.trim(),
    type: rule.type.trim(),
    keywords,
    severity: rule.severity,
    suggestion: rule.suggestion.trim() || '请根据业务需要补充脱敏展示规则。',
    enabled: Boolean(rule.enabled),
  }
}

export function validateRuleConfigs(configs: SensitiveFieldRuleConfig[]): SensitiveFieldRuleConfig[] {
  return configs.map(normalizeRuleConfig)
}

export async function loadRuleConfigs(): Promise<SensitiveFieldRuleConfig[]> {
  try {
    const parsed = JSON.parse(await readFile(rulesPath(), 'utf8')) as SensitiveFieldRuleConfig[]
    return validateRuleConfigs(parsed)
  } catch {
    return defaultRuleConfigs
  }
}

export async function saveRuleConfigs(configs: SensitiveFieldRuleConfig[]): Promise<SensitiveFieldRuleConfig[]> {
  const normalized = validateRuleConfigs(configs)
  const path = rulesPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(normalized, null, 2), 'utf8')
  return normalized
}

export async function resetRuleConfigs(): Promise<SensitiveFieldRuleConfig[]> {
  return saveRuleConfigs(defaultRuleConfigs)
}

export function compileRuleConfigs(configs: SensitiveFieldRuleConfig[]): CompiledSensitiveRule[] {
  return validateRuleConfigs(configs)
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      type: rule.type,
      pattern: new RegExp(`\\b(${rule.keywords.map(escapeRegExp).join('|')})\\b`, 'i'),
      severity: rule.severity,
      suggestion: rule.suggestion,
    }))
}
```

- [ ] **Step 5: Run tests**

Run: `rtk pnpm test`

Expected: PASS for the three new rule tests and existing tests.

### Task 2: Scanner Uses Configurable Rules

**Files:**
- Modify: `src/main/scanner.ts`
- Modify: `src/main/index.ts`
- Test: `tests/scanner.test.ts`

**Interfaces:**
- Consumes: `CompiledSensitiveRule`, `compileRuleConfigs()`, `loadRuleConfigs()`.
- Produces: `scanProject(root: string, rules?: CompiledSensitiveRule[])`.

- [ ] **Step 1: Add failing scanner tests for modified and disabled default rules**

Append to `tests/scanner.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `rtk pnpm test`

Expected: FAIL because `scanProject` does not accept a second argument.

- [ ] **Step 3: Update scanner signature and imports**

In `src/main/scanner.ts`:

```ts
import type { CompiledSensitiveRule, Finding, ProjectInfo } from './types'
import { compileRuleConfigs, defaultRuleConfigs } from './rules'
```

Delete the local `SensitiveRule` interface and `RULES` constant.

Change:

```ts
export async function scanProject(root: string): Promise<{ project: ProjectInfo; findings: Finding[] }> {
```

to:

```ts
export async function scanProject(root: string, rules: CompiledSensitiveRule[] = compileRuleConfigs(defaultRuleConfigs)): Promise<{ project: ProjectInfo; findings: Finding[] }> {
```

Change the rule lookup line to:

```ts
const rule = rules.find((candidate) => candidate.pattern.test(line))
```

- [ ] **Step 4: Load configured rules in IPC scan handler**

In `src/main/index.ts`, add import:

```ts
import { compileRuleConfigs, loadRuleConfigs } from './rules'
```

Change scan start logic:

```ts
const result = await scanProject(path)
```

to:

```ts
const rules = compileRuleConfigs(await loadRuleConfigs())
const result = await scanProject(path, rules)
```

- [ ] **Step 5: Run tests and typecheck**

Run: `rtk pnpm test && rtk pnpm typecheck`

Expected: both PASS.

### Task 3: Rule IPC And Renderer Settings UI

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/main/types.ts`

**Interfaces:**
- Consumes: `loadRuleConfigs()`, `saveRuleConfigs()`, `resetRuleConfigs()`.
- Produces preload methods: `getFieldRules()`, `saveFieldRules(configs)`, `resetFieldRules()`.

- [ ] **Step 1: Add IPC handlers**

In `src/main/index.ts`, extend imports:

```ts
import { compileRuleConfigs, loadRuleConfigs, resetRuleConfigs, saveRuleConfigs } from './rules'
import type { CliProviderId, CustomModelSettings, FindingStatus, ModelCallLog, ProviderId, ReportExportFormat, ScanReport, SensitiveFieldRuleConfig } from './types'
```

Inside `app.whenReady().then(() => { ... })`, add near settings handlers:

```ts
ipcMain.handle('field-rules:get', () => loadRuleConfigs())
ipcMain.handle('field-rules:save', (_event, configs: SensitiveFieldRuleConfig[]) => saveRuleConfigs(configs))
ipcMain.handle('field-rules:reset', () => resetRuleConfigs())
```

- [ ] **Step 2: Expose preload methods**

In `src/preload/index.ts`, extend type import with `SensitiveFieldRuleConfig` and add:

```ts
getFieldRules: (): Promise<SensitiveFieldRuleConfig[]> => ipcRenderer.invoke('field-rules:get'),
saveFieldRules: (configs: SensitiveFieldRuleConfig[]): Promise<SensitiveFieldRuleConfig[]> => ipcRenderer.invoke('field-rules:save', configs),
resetFieldRules: (): Promise<SensitiveFieldRuleConfig[]> => ipcRenderer.invoke('field-rules:reset'),
```

- [ ] **Step 3: Add settings state**

In `src/renderer/src/App.tsx`, extend type imports:

```ts
import type { CliApiKeySettings, CliPathSettings, CliProviderId, CustomModelSettings, Finding, ModelCallLog, ProjectInfo, ProviderId, ProviderStatus, ScanReport, SensitiveFieldRuleConfig } from '../../main/types'
```

Inside `SettingsDialog`, add state:

```ts
const [fieldRules, setFieldRules] = useState<SensitiveFieldRuleConfig[]>([])
```

Inside the existing `useEffect`, add:

```ts
window.sensiScan.getFieldRules().then(setFieldRules).catch(() => setMessage('无法读取字段检测规则。'))
```

- [ ] **Step 4: Add rule editing helpers**

Inside `SettingsDialog`, before `return`, add:

```tsx
function updateFieldRule(id: string, updates: Partial<SensitiveFieldRuleConfig>): void {
  setFieldRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...updates } : rule))
}

function keywordsText(rule: SensitiveFieldRuleConfig): string {
  return rule.keywords.join('\n')
}

function parseKeywords(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))]
}

function addFieldRule(): void {
  const id = `custom-${Date.now()}`
  setFieldRules((current) => [...current, {
    id,
    type: '新增字段',
    keywords: ['fieldName'],
    severity: 'medium',
    suggestion: '请根据业务需要补充脱敏展示规则。',
    enabled: true,
  }])
}

async function saveFieldRules(): Promise<void> {
  setMessage(null)
  try {
    setFieldRules(await window.sensiScan.saveFieldRules(fieldRules))
    setMessage('字段检测规则已保存。')
  } catch (saveError) {
    setMessage(saveError instanceof Error ? saveError.message : '字段检测规则保存失败。')
  }
}

async function resetFieldRules(): Promise<void> {
  setMessage(null)
  try {
    setFieldRules(await window.sensiScan.resetFieldRules())
    setMessage('字段检测规则已恢复默认。')
  } catch {
    setMessage('字段检测规则恢复失败。')
  }
}
```

- [ ] **Step 5: Render rule editor**

In `SettingsDialog` JSX, after the “代码读取范围” block and before custom model settings, insert:

```tsx
<div className="model-settings">
  <strong>字段检测规则</strong>
  <p>默认规则也可以修改。字段关键词支持逗号或换行分隔，不支持直接输入正则。</p>
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
      <label>字段关键词<textarea value={keywordsText(rule)} rows={3} onChange={(event) => updateFieldRule(rule.id, { keywords: parseKeywords(event.target.value) })} /></label>
      <label>处理建议<textarea value={rule.suggestion} rows={2} onChange={(event) => updateFieldRule(rule.id, { suggestion: event.target.value })} /></label>
      <div className="field-rule-actions">
        <label><input type="checkbox" checked={rule.enabled} onChange={(event) => updateFieldRule(rule.id, { enabled: event.target.checked })} /> 启用</label>
        <button className="secondary-button" type="button" onClick={() => setFieldRules((current) => current.filter((item) => item.id !== rule.id))}>删除</button>
      </div>
    </div>
  ))}
  <span>
    <button className="secondary-button" type="button" onClick={addFieldRule}>新增字段类型</button>
    <button className="secondary-button" type="button" onClick={resetFieldRules}>恢复默认规则</button>
    <button className="primary-button" type="button" onClick={saveFieldRules}>保存字段规则</button>
  </span>
</div>
```

- [ ] **Step 6: Add minimal CSS if needed**

If `src/renderer/src/App.tsx` uses classes not yet styled, add focused rules to `src/renderer/src/style.css` after existing settings styles:

```css
.field-rule-row {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  background: #fff;
}

.field-rule-row textarea,
.field-rule-row select {
  width: 100%;
  border: 1px solid #d8dee8;
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
}

.field-rule-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
```

- [ ] **Step 7: Run typecheck**

Run: `rtk pnpm typecheck`

Expected: PASS.

### Task 4: Excel Report Export

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/main/report.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/App.tsx`
- Test: `tests/scanner.test.ts`

**Interfaces:**
- Produces: `scanReportToExcel(report: ScanReport): Buffer`.
- Consumes: `ReportExportFormat`.

- [ ] **Step 1: Install SheetJS**

Run: `rtk pnpm add xlsx`

Expected: `package.json` and `pnpm-lock.yaml` update with latest `xlsx`.

- [ ] **Step 2: Add failing Excel export test**

Add these imports at the top of `tests/scanner.test.ts` with the existing imports:

```ts
import { read } from 'xlsx'
import { scanReportToExcel } from '../src/main/report'
```

Append this test to `tests/scanner.test.ts`:

```ts
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
  assert.equal(sheet.A2.v, '地址展示')
  assert.equal(sheet.C2.v, '待确认')
  assert.equal(sheet.A3.v, '手机号完整展示')
  assert.equal(sheet.C3.v, '已确认')
  assert.equal(sheet.A4.v, '邮箱展示')
  assert.equal(sheet.C4.v, '合理展示')
})
```

- [ ] **Step 3: Run tests to verify failure**

Run: `rtk pnpm test`

Expected: FAIL because `scanReportToExcel` does not exist.

- [ ] **Step 4: Implement Excel export**

In `src/main/report.ts`, add import:

```ts
import { utils, write } from 'xlsx'
```

Add below existing name maps:

```ts
const statusOrder = { suspected: 0, confirmed: 1, safe: 2 }
```

Add function:

```ts
export function scanReportToExcel(report: ScanReport): Buffer {
  const rows = [
    ['问题', '风险等级', '状态', '敏感信息', '路由', '接口路径', '代码位置'],
    ...[...report.findings]
      .sort((left, right) => statusOrder[left.status] - statusOrder[right.status])
      .map((finding) => [
        finding.title,
        severityNames[finding.severity],
        statusNames[finding.status],
        finding.sensitiveType,
        finding.route,
        finding.api,
        `${finding.file}:${finding.line}`,
      ]),
  ]
  const sheet = utils.aoa_to_sheet(rows)
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, sheet, '敏感信息体检')
  return write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
```

- [ ] **Step 5: Update export IPC**

In `src/main/index.ts`, update imports:

```ts
import { scanReportToExcel, scanReportToMarkdown } from './report'
```

Change `report:export` handler signature:

```ts
ipcMain.handle('report:export', async (_event, report: ScanReport, format: ReportExportFormat = 'markdown') => {
```

Replace dialog setup and write call with:

```ts
const isExcel = format === 'excel'
const result = await dialog.showSaveDialog({
  title: isExcel ? '导出 Excel 报告' : '导出 Markdown 报告',
  defaultPath: `${report.project.name}-敏感信息体检报告.${isExcel ? 'xlsx' : 'md'}`,
  filters: [isExcel ? { name: 'Excel', extensions: ['xlsx'] } : { name: 'Markdown', extensions: ['md'] }],
})
if (result.canceled || !result.filePath) return false
await writeFile(result.filePath, isExcel ? scanReportToExcel(report) : scanReportToMarkdown(report), isExcel ? undefined : 'utf8')
return true
```

- [ ] **Step 6: Update preload and renderer button**

In `src/preload/index.ts`, import `ReportExportFormat` and change:

```ts
exportReport: (report: ScanReport, format: ReportExportFormat = 'markdown'): Promise<boolean> => ipcRenderer.invoke('report:export', report, format),
```

In `src/renderer/src/App.tsx`, change `exportReport` to accept a format:

```tsx
async function exportReport(format: 'markdown' | 'excel'): Promise<void> {
  setExportMessage(null)
  try {
    if (await window.sensiScan.exportReport(report, format)) setExportMessage(format === 'excel' ? 'Excel 报告已导出。' : 'Markdown 报告已导出。')
  } catch (exportError) {
    setExportMessage(exportError instanceof Error ? exportError.message : '报告导出失败。')
  }
}
```

Change buttons:

```tsx
<button className="secondary-button" onClick={() => exportReport('excel')}><DownloadSimple size={17} /> 导出 Excel</button>
<button className="primary-button" onClick={() => exportReport('markdown')}><DownloadSimple size={17} /> 导出 Markdown</button>
```

- [ ] **Step 7: Run tests and typecheck**

Run: `rtk pnpm test && rtk pnpm typecheck`

Expected: both PASS.

### Task 5: Final Verification

**Files:**
- Verify all changed files.

**Interfaces:**
- Consumes all previous task outputs.
- Produces a working feature with passing tests and typecheck.

- [ ] **Step 1: Run full verification**

Run: `rtk pnpm test && rtk pnpm typecheck`

Expected: PASS.

- [ ] **Step 2: Inspect git diff**

Run: `rtk git diff -- src/main/types.ts src/main/rules.ts src/main/scanner.ts src/main/index.ts src/main/report.ts src/preload/index.ts src/renderer/src/App.tsx src/renderer/src/style.css tests/scanner.test.ts package.json pnpm-lock.yaml docs/superpowers/specs/2026-06-23-excel-export-field-rules-design.md docs/superpowers/plans/2026-06-23-excel-export-field-rules.md`

Expected: Diff only contains Excel export, editable field rules, tests, dependency lockfile, and docs.

- [ ] **Step 3: Manual smoke test in app**

Run: `rtk pnpm dev`

Expected:
- Settings opens and shows default field rules.
- Default rules are editable and savable.
- Adding a field type persists after closing and reopening settings.
- Restoring defaults returns the original six rules.
- A scan still finds existing sample sensitive fields.
- Result page exports Markdown and Excel.
- Excel opens with the seven required columns sorted by status.

- [ ] **Step 4: Summarize without committing**

Do not run `git commit` unless the user explicitly asks. Final response should list changed behavior and verification commands with results.
