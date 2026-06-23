# 敏感信息体检

面向非技术用户的 Windows/Linux 桌面扫描工具。选择本地代码目录后，应用会自动识别技术栈并检查手机号、身份证、银行卡、邮箱、地址、姓名等信息是否未经脱敏进入页面、接口、日志或导出位置。

## 当前能力

- 图形化选择或拖入代码目录，无需初始化配置。
- 内置只读规则扫描，默认不上传、不修改代码。
- 自动识别 Java/Spring、Kotlin、React、Vue、TypeScript/JavaScript。
- 报告包含风险等级、文件行号、页面路由、接口路径、证据和修复建议。
- 可选使用 Qoder CLI 或 CodeBuddy CLI 对规则候选结果做 AI 复核。
- 未安装 Qoder CLI 或 CodeBuddy CLI 时，可在应用内安装；Mac 缺少 Node.js 时会自动下载并校验官方 Node.js，同时安装 pnpm。
- 可配置 OpenAI 兼容的 Base URL、API Key 和模型，对规则候选结果做 AI 复核。
- AI 只收到候选问题及短代码片段，调用时禁用内置工具，不授予文件修改或命令执行能力。

自定义模型在右上角“设置”中配置。远程地址必须使用 HTTPS，本地 `localhost` 地址可使用 HTTP；API Key 由 Electron 系统安全存储加密，不会写入明文配置。

## 开发

要求 Node.js 20+、pnpm。

```bash
pnpm install
pnpm dev
```

验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

打包：

```bash
pnpm package
```

Electron Builder 配置了 Windows 的 NSIS/portable 和 Linux 的 AppImage/deb 目标。发布安装包应在对应操作系统上构建。

## Qoder CLI

官方安装：

```bash
npm install -g @qoder-ai/qodercli
qodercli login
```

也支持通过 `QODER_PERSONAL_ACCESS_TOKEN` 登录。应用检测到 `qodercli` 后会开放 Qoder 复核选项，实际调用使用非交互 `-p` 模式并禁用工具。

文档：https://qoder.com/cli

## CodeBuddy CLI

官方安装：

```bash
npm install -g @tencent-ai/codebuddy-code
codebuddy
```

首次运行按官方流程完成登录。应用检测 `codebuddy` 或 `cbc` 命令，实际调用使用 `-p --output-format json --json-schema -y`；同时通过 `--disallowedTools` 禁用文件读写、命令执行和网络等工具。

文档：https://www.codebuddy.cn/cli/

## 扫描边界

这是静态候选扫描工具，不等价于完整的数据流或权限审计。无法从代码证明的路由和接口会显示“待确认”，AI 结果仍需人工结合实际访问权限复核。
