import { app } from 'electron'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CopilotChatState } from '../../shared/types'

const FILE_NAME = 'copilotChats.json'

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function parseState(raw: string): CopilotChatState | null {
  try {
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    const state = data as Partial<CopilotChatState>
    if (typeof state.activeTabId !== 'string' || !Array.isArray(state.tabs)) return null
    return state as CopilotChatState
  } catch {
    return null
  }
}

export function readCopilotChats(): CopilotChatState | null {
  const path = filePath()
  if (!existsSync(path)) return null
  try {
    return parseState(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function writeCopilotChats(state: CopilotChatState | null): void {
  const path = filePath()
  if (state === null) {
    if (existsSync(path)) unlinkSync(path)
    return
  }

  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
}
