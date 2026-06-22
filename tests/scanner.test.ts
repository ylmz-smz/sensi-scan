import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectProject, scanProject } from '../src/main/scanner'
import { nodeArchive, providerInstallArgs, windowsNodeCandidates } from '../src/main/installer'

test('生成官方 CLI 安装参数并定位 Windows Node.js', () => {
  assert.deepEqual(providerInstallArgs('qoder'), ['install', '-g', '@qoder-ai/qodercli@latest'])
  assert.deepEqual(providerInstallArgs('codebuddy'), ['install', '-g', '@tencent-ai/codebuddy-code@latest'])
  assert.deepEqual(windowsNodeCandidates({ ProgramFiles: 'C:\\Program Files' }), ['C:\\Program Files\\nodejs\\node.exe'])
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
