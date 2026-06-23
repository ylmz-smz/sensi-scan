import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CompiledSensitiveRule, SensitiveFieldRuleConfig, SensitiveFieldRuleConfigState, Severity } from './types'

const severityValues = new Set<Severity>(['high', 'medium', 'low'])

const defaultRuleConfigSource: SensitiveFieldRuleConfig[] = [
  { id: 'phone', type: '手机号', keywords: ['phone', 'mobile', 'phoneNumber', 'mobileNo', 'tel'], severity: 'medium', suggestion: '默认展示前三后四，例如 133****3333。', enabled: true },
  { id: 'id-card', type: '身份证号', keywords: ['idCard', 'identityCard', 'idNumber', 'certNo', 'certificateNo'], severity: 'high', suggestion: '仅保留必要的首尾字符，其余使用星号遮盖。', enabled: true },
  { id: 'bank-card', type: '银行卡号', keywords: ['bankCard', 'cardNumber', 'bankAccount', 'accountNo'], severity: 'high', suggestion: '默认仅展示末四位，完整信息仅在明确授权场景提供。', enabled: true },
  { id: 'email', type: '邮箱', keywords: ['email', 'mailAddress'], severity: 'low', suggestion: '隐藏邮箱用户名中段，并确认页面访问权限。', enabled: true },
  { id: 'address', type: '地址', keywords: ['address', 'homeAddress', 'detailAddress', 'receiverAddress'], severity: 'medium', suggestion: '按业务需要隐藏门牌号或详细地址，并限制导出权限。', enabled: true },
  { id: 'name', type: '姓名', keywords: ['realName', 'fullName', 'userName', 'customerName'], severity: 'low', suggestion: '根据业务角色展示姓氏或部分姓名。', enabled: true },
]

function cloneRuleConfig(rule: SensitiveFieldRuleConfig): SensitiveFieldRuleConfig {
  return {
    ...rule,
    keywords: [...rule.keywords],
  }
}

function createDefaultRuleConfigs(): SensitiveFieldRuleConfig[] {
  return defaultRuleConfigSource.map(cloneRuleConfig)
}

export const defaultRuleConfigs: SensitiveFieldRuleConfig[] = createDefaultRuleConfigs()

function rulesPath(): string {
  return join(app.getPath('userData'), 'field-rules.json')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function keywordPattern(keyword: string): string {
  const escaped = escapeRegExp(keyword)
  return /^[A-Za-z0-9_]+$/.test(keyword)
    ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`
    : escaped
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
  const normalized = configs.map(normalizeRuleConfig)
  const ids = new Set<string>()

  for (const rule of normalized) {
    if (ids.has(rule.id)) throw new Error(`规则 ID 不能重复：${rule.id}`)
    ids.add(rule.id)
  }

  return normalized
}

export async function loadRuleConfigs(): Promise<SensitiveFieldRuleConfig[]> {
  return (await loadRuleConfigState()).configs
}

export async function loadRuleConfigState(path?: string): Promise<SensitiveFieldRuleConfigState> {
  try {
    const parsed = JSON.parse(await readFile(path ?? rulesPath(), 'utf8')) as SensitiveFieldRuleConfig[]
    return { configs: validateRuleConfigs(parsed), usingDefaults: false }
  } catch (error) {
    return {
      configs: createDefaultRuleConfigs(),
      usingDefaults: true,
      error: isMissingFileError(error) ? undefined : '字段检测规则读取失败，已临时使用默认规则。',
    }
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
  return saveRuleConfigs(createDefaultRuleConfigs())
}

export function compileRuleConfigs(configs: SensitiveFieldRuleConfig[]): CompiledSensitiveRule[] {
  return validateRuleConfigs(configs)
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      type: rule.type,
      pattern: new RegExp(rule.keywords.map(keywordPattern).join('|'), 'i'),
      severity: rule.severity,
      suggestion: rule.suggestion,
    }))
}
