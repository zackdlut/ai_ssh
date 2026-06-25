export interface ConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  /** Plaintext password (stored locally only). */
  password?: string
  /** Path to a private key file, or the key contents. */
  privateKey?: string
  passphrase?: string
}

export interface ConnectOptions {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface ConnectResult {
  sessionId?: string
  error?: string
}

export type SshStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SshStatusEvent {
  sessionId: string
  status: SshStatus
  message?: string
}

export interface SshDataEvent {
  sessionId: string
  data: string
}

export interface AISettings {
  baseURL: string
  apiKey: string
  model: string
}

export interface ChatMessageDTO {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface TerminalContext {
  /** Recent terminal output (trimmed to the last N lines). */
  recentOutput: string
  host?: string
  username?: string
  osHint?: string
}

export interface AIChatRequest {
  requestId: string
  messages: ChatMessageDTO[]
  context?: TerminalContext
}

export interface AIChunkEvent {
  requestId: string
  delta: string
}

export interface AIDoneEvent {
  requestId: string
  content: string
}

export interface AIErrorEvent {
  requestId: string
  error: string
}
