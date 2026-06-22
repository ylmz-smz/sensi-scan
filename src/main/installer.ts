import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { arch } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { ProviderId } from './types'

const execFileAsync = promisify(execFile)

type CliProviderId = Extract<ProviderId, 'qoder' | 'codebuddy'>

const PACKAGES: Record<CliProviderId, string> = {
  qoder: '@qoder-ai/qodercli@latest',
  codebuddy: '@tencent-ai/codebuddy-code@latest',
}

export function providerInstallArgs(provider: CliProviderId): string[] {
  if (!PACKAGES[provider]) throw new Error('不支持安装该工具')
  return ['install', '-g', PACKAGES[provider]]
}

export function windowsNodeCandidates(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([
    env.ProgramFiles && win32.join(env.ProgramFiles, 'nodejs', 'node.exe'),
    env.ProgramW6432 && win32.join(env.ProgramW6432, 'nodejs', 'node.exe'),
    env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'nodejs', 'node.exe'),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'),
  ].filter((path): path is string => Boolean(path)))]
}

export function nodeArchive(checksums: string, cpu: string): { filename: string; checksum: string } {
  if (!['arm64', 'x64'].includes(cpu)) throw new Error(`暂不支持此 Mac 架构：${cpu}`)
  const suffix = `-darwin-${cpu}.tar.gz`
  const line = checksums.split(/\r?\n/).find((item) => item.endsWith(suffix))
  const match = line?.match(/^([a-f0-9]{64})  (node-v\d+\.\d+\.\d+-darwin-(?:arm64|x64)\.tar\.gz)$/)
  if (!match) throw new Error('Node.js 官方下载清单中没有兼容的 Mac 版本')
  return { checksum: match[1], filename: match[2] }
}

async function windowsNpmCommand(): Promise<{ command: string; args: string[] }> {
  let located: string[] = []
  try {
    const { stdout } = await execFileAsync('where.exe', ['node.exe'], { timeout: 3000 })
    located = stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean)
  } catch {
    // Fall back to the official Node.js install locations below.
  }
  for (const command of [...located, ...windowsNodeCandidates(process.env)]) {
    const npmCli = win32.join(win32.dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(command) && existsSync(npmCli)) return { command, args: [npmCli] }
  }
  throw new Error('未检测到 npm，请确认已安装 Node.js 20+，然后重新打开应用。')
}

async function macNpmCommand(): Promise<{ command: string; args: string[] }> {
  try {
    const { stdout } = await execFileAsync('node', ['-p', 'process.versions.node'], { timeout: 3000 })
    if (Number(stdout.trim().split('.')[0]) >= 20) {
      await execFileAsync('npm', ['--version'], { timeout: 3000 })
      try {
        await execFileAsync('pnpm', ['--version'], { timeout: 3000 })
      } catch {
        await execFileAsync('npm', ['install', '-g', 'pnpm@latest'], { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 })
      }
      return { command: 'npm', args: [] }
    }
  } catch {
    // Use an app-managed runtime when the system installation is missing or unusable.
  }
  const runtime = join(app.getPath('userData'), 'node')
  const node = join(runtime, 'bin/node')
  const npmCli = join(runtime, 'lib/node_modules/npm/bin/npm-cli.js')
  if (!existsSync(node) || !existsSync(npmCli)) {
    await mkdir(dirname(runtime), { recursive: true })
    const baseUrl = 'https://nodejs.org/dist/latest-v22.x'
    const checksums = await fetch(`${baseUrl}/SHASUMS256.txt`).then((response) => {
      if (!response.ok) throw new Error(`下载 Node.js 清单失败：HTTP ${response.status}`)
      return response.text()
    })
    const selected = nodeArchive(checksums, arch())
    const work = await mkdtemp(join(dirname(runtime), 'node-download-'))
    try {
      const archive = join(work, selected.filename)
      const response = await fetch(`${baseUrl}/${selected.filename}`)
      if (!response.ok) throw new Error(`下载 Node.js 失败：HTTP ${response.status}`)
      await writeFile(archive, Buffer.from(await response.arrayBuffer()))
      const actual = createHash('sha256').update(await readFile(archive)).digest('hex')
      if (actual !== selected.checksum) throw new Error('Node.js 下载校验失败，已取消安装')
      const extracted = join(work, 'node')
      await mkdir(extracted)
      await execFileAsync('tar', ['-xzf', archive, '--strip-components=1', '-C', extracted], { timeout: 2 * 60 * 1000 })
      await rm(runtime, { recursive: true, force: true })
      await rename(extracted, runtime)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
    await execFileAsync(node, [npmCli, 'install', '-g', 'pnpm@latest'], { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 })
  }
  process.env.PATH = `${join(runtime, 'bin')}:${process.env.PATH ?? ''}`
  return { command: node, args: [npmCli] }
}

export async function installProvider(provider: CliProviderId): Promise<void> {
  const installArgs = providerInstallArgs(provider)
  const npm = process.platform === 'win32' ? await windowsNpmCommand() : process.platform === 'darwin' ? await macNpmCommand() : { command: 'npm', args: [] }
  try {
    await execFileAsync(npm.command, [...npm.args, ...installArgs], { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 })
  } catch (error) {
    const failure = error as { code?: string; stderr?: string; message?: string }
    if (failure.code === 'ENOENT') throw new Error('未检测到 npm，请先按官网安装 Node.js 20+。')
    const detail = failure.stderr?.trim() || failure.message || '未知错误'
    if (detail.includes('EACCES') || detail.includes('permission denied')) throw new Error('没有全局安装权限，请按官网说明调整 npm 权限后重试。')
    throw new Error(`安装失败：${detail.slice(-600)}`)
  }
}
