import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FindingStatus } from './types'

type StoredStatus = Extract<FindingStatus, 'confirmed' | 'safe'>
type Decisions = Record<string, StoredStatus>

function decisionsPath(): string {
  return join(app.getPath('userData'), 'decisions.json')
}

export async function loadDecisions(): Promise<Decisions> {
  try {
    return JSON.parse(await readFile(decisionsPath(), 'utf8')) as Decisions
  } catch {
    return {}
  }
}

export async function saveDecision(id: string, status: StoredStatus): Promise<void> {
  const path = decisionsPath()
  const decisions = await loadDecisions()
  decisions[id] = status
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(decisions, null, 2), 'utf8')
}
