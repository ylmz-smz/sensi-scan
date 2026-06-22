import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, parse, relative } from 'node:path'
import type { Finding, ProjectInfo, Severity } from './types'

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.java', '.kt', '.kts', '.html', '.jsp', '.xml',
])
const SKIP_DIRECTORIES = new Set([
  '.git', '.idea', '.vscode', 'node_modules', 'dist', 'build', 'target', 'vendor', 'coverage', '.next',
])
const MAX_FILE_SIZE = 1024 * 1024

interface SensitiveRule {
  type: string
  pattern: RegExp
  severity: Severity
  suggestion: string
}

const RULES: SensitiveRule[] = [
  { type: '手机号', pattern: /\b(phone|mobile|phoneNumber|mobileNo|tel)\b/i, severity: 'medium', suggestion: '默认展示前三后四，例如 133****3333。' },
  { type: '身份证号', pattern: /\b(idCard|identityCard|idNumber|certNo|certificateNo)\b/i, severity: 'high', suggestion: '仅保留必要的首尾字符，其余使用星号遮盖。' },
  { type: '银行卡号', pattern: /\b(bankCard|cardNumber|bankAccount|accountNo)\b/i, severity: 'high', suggestion: '默认仅展示末四位，完整信息仅在明确授权场景提供。' },
  { type: '邮箱', pattern: /\b(email|mailAddress)\b/i, severity: 'low', suggestion: '隐藏邮箱用户名中段，并确认页面访问权限。' },
  { type: '地址', pattern: /\b(address|homeAddress|detailAddress|receiverAddress)\b/i, severity: 'medium', suggestion: '按业务需要隐藏门牌号或详细地址，并限制导出权限。' },
  { type: '姓名', pattern: /\b(realName|fullName|userName|customerName)\b/i, severity: 'low', suggestion: '根据业务角色展示姓氏或部分姓名。' },
]

const SAFE_PATTERN = /(mask|masked|desensiti[sz]e|脱敏|encrypt|hideMiddle|privacy|\*{2,})/i
const OUTPUT_PATTERN = /(return\s|logger\.|log\.|download|export(Data|File|Excel|Csv)|excel|csv|write\(|dataIndex|render\s*[:=]|value\s*=|text\s*=|\{\{|<td|<span|<p|set[A-Z]|ResponseEntity|@JsonProperty|class\s+\w*(VO|DTO|View))/i
const API_PATTERN = /@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)/
const ROUTE_PATTERN = /(?:path\s*:\s*|<Route[^>]+path\s*=\s*)["']([^"']+)/

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function visit(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (directory === root) throw error
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(path)
        continue
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const fileStat = await stat(path)
      if (fileStat.size <= MAX_FILE_SIZE) files.push(path)
    }
  }

  await visit(root)
  return files
}

function detectTechnologies(files: string[]): string[] {
  const extensions = new Set(files.map((file) => extname(file).toLowerCase()))
  const names = new Set(files.map((file) => basename(file)))
  const technologies: string[] = []
  if (extensions.has('.java')) technologies.push('Java', 'Spring Boot')
  if (extensions.has('.kt') || extensions.has('.kts')) technologies.push('Kotlin')
  if (extensions.has('.vue')) technologies.push('Vue')
  if (extensions.has('.tsx') || extensions.has('.jsx')) technologies.push('React')
  if ((extensions.has('.ts') || extensions.has('.js')) && !technologies.includes('React')) technologies.push('TypeScript / JavaScript')
  if (names.has('pom.xml')) technologies.push('Maven')
  return [...new Set(technologies)]
}

function nearbyPath(lines: string[], index: number, pattern: RegExp): string {
  for (let offset = index; offset >= Math.max(0, index - 100); offset -= 1) {
    const match = lines[offset].match(pattern)
    if (match?.[2]) return match[2]
    if (match?.[1] && pattern === ROUTE_PATTERN) return match[1]
  }
  return '待确认'
}

function routeMap(files: { path: string; source: string }[]): Map<string, string> {
  // ponytail: Regex covers common React/Vue routes; use framework ASTs only when real projects expose misses.
  const routes = new Map<string, Set<string>>()
  for (const file of files) {
    const source = file.source.replace(/\s+/g, ' ')
    const patterns = [
      /<Route\b[^>]*\bpath\s*=\s*["']([^"']+)["'][^>]*\belement\s*=\s*\{\s*<(\w+)/g,
      /\bpath\s*:\s*["']([^"']+)["'][^{}]{0,300}\b(?:component|element)\s*:\s*(?:<)?(\w+)/g,
    ]
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const values = routes.get(match[2]) ?? new Set<string>()
        values.add(match[1])
        routes.set(match[2], values)
      }
    }
  }
  return new Map([...routes].flatMap(([component, values]) => values.size === 1 ? [[component, [...values][0]]] : []))
}

function fingerprint(file: string, type: string, snippet: string): string {
  return createHash('sha256').update(`${file}:${type}:${snippet.trim().replace(/\s+/g, ' ')}`).digest('hex').slice(0, 16)
}

export async function inspectProject(root: string): Promise<ProjectInfo> {
  const files = await collectFiles(root)
  return {
    path: root,
    name: basename(root),
    files: files.length,
    technologies: detectTechnologies(files),
  }
}

export async function scanProject(root: string): Promise<{ project: ProjectInfo; findings: Finding[] }> {
  const files = await collectFiles(root)
  const findings: Finding[] = []
  const sources = (await Promise.all(files.map(async (path) => {
    try {
      return { path, source: await readFile(path, 'utf8') }
    } catch {
      return null
    }
  }))).filter((item): item is { path: string; source: string } => item !== null)
  const routes = routeMap(sources)

  for (const { path: absoluteFile, source } of sources) {
    const lines = source.split(/\r?\n/)
    const file = relative(root, absoluteFile)

    lines.forEach((line, index) => {
      if (SAFE_PATTERN.test(line) || !OUTPUT_PATTERN.test(line)) return
      const rule = RULES.find((candidate) => candidate.pattern.test(line))
      if (!rule) return

      const snippet = line.trim().slice(0, 280)
      const isExportOrLog = /(logger\.|log\.|download|export(Data|File|Excel|Csv)|excel|csv|write\()/i.test(line)
      const localRoute = nearbyPath(lines, index, ROUTE_PATTERN)
      findings.push({
        id: fingerprint(file, rule.type, snippet),
        severity: isExportOrLog ? 'high' : rule.severity,
        status: 'suspected',
        sensitiveType: rule.type,
        title: `${rule.type}可能以完整值展示`,
        reason: isExportOrLog ? '该字段进入日志或导出路径，未在当前代码附近发现脱敏处理。' : '该字段进入展示或接口输出位置，未在当前代码附近发现脱敏处理。',
        file,
        line: index + 1,
        snippet,
        route: localRoute === '待确认' ? routes.get(parse(file).name) ?? localRoute : localRoute,
        api: nearbyPath(lines, index, API_PATTERN),
        suggestion: rule.suggestion,
      })
    })
  }

  return {
    project: {
      path: root,
      name: basename(root),
      files: files.length,
      technologies: detectTechnologies(files),
    },
    findings: findings.slice(0, 200),
  }
}
