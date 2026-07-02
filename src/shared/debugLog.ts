export type DebugCategory =
  | 'user.action'
  | 'action.triggered'
  | 'llm.request'
  | 'llm.response'
  | 'llm.error'
  | 'ipc'

export interface DebugLogEntry {
  ts: string
  sessionId: string
  category: DebugCategory
  traceId?: string
  tabId?: string
  sessionId_ssh?: string
  message: string
  data?: unknown
  durationMs?: number
}

/** Payload sent from renderer → main (ts and sessionId are filled in main). */
export type DebugLogPayload = Omit<DebugLogEntry, 'ts' | 'sessionId'>

export interface DebugLogSettings {
  enabled: boolean
}
