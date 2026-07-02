import { app } from 'electron'
import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { DebugLogEntry, DebugLogPayload } from '../../shared/debugLog'
import { sanitizeForDebug } from '../../shared/debugSanitize'

type EnabledGetter = () => boolean

let sessionId = randomUUID()
let getEnabled: EnabledGetter = () => false
let writeErrorLogged = false

export function initDebugLogger(getEnabledFn: EnabledGetter): void {
  getEnabled = getEnabledFn
}

export function getDebugSessionId(): string {
  return sessionId
}

function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10)
  return join(logDir(), `debug-${date}.log`)
}

export function logDebug(entry: DebugLogPayload): void {
  if (!getEnabled()) return

  const full: DebugLogEntry = {
    ...entry,
    ts: new Date().toISOString(),
    sessionId,
    data: entry.data !== undefined ? sanitizeForDebug(entry.data) : undefined
  }

  void writeLine(full)
}

async function writeLine(entry: DebugLogEntry): Promise<void> {
  try {
    const dir = logDir()
    await mkdir(dir, { recursive: true })
    const line = `${JSON.stringify(entry)}\n`
    await appendFile(logFilePath(), line, 'utf8')
  } catch (e) {
    if (!writeErrorLogged) {
      writeErrorLogged = true
      console.error('[debug-log] failed to write:', e instanceof Error ? e.message : e)
    }
  }
}
