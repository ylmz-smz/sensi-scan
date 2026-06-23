# Excel 导出和字段检测配置设计

## 目标

新增真正的 `.xlsx` 导出能力，并让敏感字段检测规则可配置。导出的 Excel 面向业务复核流转，字段检测配置面向非技术用户维护项目里的字段命名差异。

## 范围

- 结果页新增 Excel 导出入口，保留现有 Markdown 导出。
- Excel 表头固定为：问题、风险等级、状态、敏感信息、路由、接口路径、代码位置。
- Excel 行按状态排序：待确认、已确认、合理展示。
- 当前内置检测规则作为默认配置加载，用户可以修改默认规则的字段、风险等级和建议文案。
- 用户可以新增、删除字段类型，也可以恢复默认规则。
- 扫描仍只读取用户选择的代码目录，不修改被扫描项目。

## 数据结构

默认规则不再作为扫描器里的私有硬编码数组直接使用，而是提升为可序列化配置：

```ts
interface SensitiveFieldRuleConfig {
  id: string
  type: string
  keywords: string[]
  severity: Severity
  suggestion: string
  enabled: boolean
}
```

扫描器内部再把 `keywords` 编译为正则。用户不直接输入正则，避免一个错误表达式拖死扫描。默认规则包括手机号、身份证号、银行卡号、邮箱、地址、姓名，这些规则首次打开配置时就是普通可编辑项。

## 主进程边界

新增规则配置持久化模块，例如 `src/main/rules.ts`：

- `loadRuleConfigs()`：读取用户配置；不存在时返回默认规则。
- `saveRuleConfigs(configs)`：校验后写入 `userData`。
- `resetRuleConfigs()`：恢复默认规则。
- `compileRuleConfigs(configs)`：过滤禁用项，把关键词转为扫描器可用规则。

`scanProject(root)` 改为从配置加载规则，或接收规则参数。为了保持现有调用简单，推荐在 `scan:start` IPC 中加载配置并传给 `scanProject(root, rules)`。

## 导出设计

报告层新增 `scanReportToExcel(report): Buffer`。主进程 `report:export` 支持格式参数：

- `markdown`：沿用现有 `.md` 导出。
- `excel`：保存为 `.xlsx`。

Excel 只导出用户要求的 7 列，不塞代码片段和建议，避免表格变成垃圾桶。代码位置用 `file:line`，状态和风险等级使用中文显示。

## Renderer 设计

结果页新增“导出 Excel”按钮，调用 `window.sensiScan.exportReport(report, 'excel')`。

设置弹窗新增“字段检测规则”区块：

- 展示规则列表。
- 每条规则可编辑字段类型、关键词、风险等级、建议、启用状态。
- 支持新增字段类型。
- 支持删除规则。
- 支持恢复默认规则。

关键词输入用逗号或换行分隔，保存时统一清洗空白和重复项。

## 错误处理

- 配置读取失败时使用默认规则，并在设置页提示配置读取失败。
- 保存时拒绝空字段类型、空关键词、非法风险等级。
- Excel 导出失败时复用现有导出错误提示。
- 规则配置不会影响已有人工决策，`finding.id` 仍由文件、类型和代码片段生成；修改字段类型会产生新的问题 ID，这是可接受的，因为语义已经变了。

## 测试

- 测试 Excel 导出按状态排序，并包含固定表头。
- 测试默认规则可加载为配置。
- 测试修改默认手机号关键词后，扫描使用新关键词。
- 测试禁用规则后不再命中。
- 测试 Markdown 导出保持现有行为。

## 非目标

- 不做复杂 Excel 样式、筛选器和多 sheet。
- 不支持用户直接写正则。
- 不做项目级配置文件写回，配置只保存在应用 `userData`。
