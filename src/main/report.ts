import { utils, write } from 'xlsx'
import type { Finding, ScanReport } from './types'

const providerNames = {
  local: '本地规则',
  custom: '自定义模型',
  qoder: 'Qoder CLI',
  codebuddy: 'CodeBuddy CLI',
}

const severityNames = { high: '高', medium: '中', low: '低' }
const statusNames = { confirmed: '已确认', suspected: '待确认', safe: '合理展示' }
const statusOrder = { suspected: 0, confirmed: 1, safe: 2 }

function findingMarkdown(finding: Finding, index: number): string {
  const snippet = finding.snippet.split('\n').map((line) => `    ${line}`).join('\n')
  return `## ${index + 1}. ${finding.title}

- 风险等级：${severityNames[finding.severity]}
- 状态：${statusNames[finding.status]}
- 敏感信息：${finding.sensitiveType}
- 页面路由：${finding.route}
- 接口路径：${finding.api}
- 代码位置：${finding.file}:${finding.line}

${finding.reason}

### 证据代码

${snippet}

### 建议处理方式

${finding.suggestion}`
}

export function scanReportToMarkdown(report: ScanReport): string {
  const findings = report.findings.map(findingMarkdown).join('\n\n')
  return `# ${report.project.name} 敏感信息体检报告

- 检查时间：${new Date(report.startedAt).toLocaleString('zh-CN')}
- 项目路径：${report.project.path}
- 检查方式：${providerNames[report.provider]}
- 扫描文件：${report.scannedFiles}
- 用时：${(report.durationMs / 1000).toFixed(1)} 秒
- 问题数量：${report.findings.length}

${report.providerMessage ? `> AI 复核未完成：${report.providerMessage}\n\n` : ''}${findings || '未发现明显的未脱敏展示。'}
`
}

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
