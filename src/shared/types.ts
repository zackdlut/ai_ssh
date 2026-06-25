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
  /** Parent folder id, or null/undefined for the tree root. */
  parentId?: string | null
  /** Sort order within the parent. */
  order?: number
  /** Number of times this connection has been opened. */
  useCount?: number
  /** Timestamp (ms) when this connection was last opened. */
  lastUsedAt?: number
}

/** A bookmark folder used to group saved connections into a nested tree. */
export interface BookmarkFolder {
  id: string
  name: string
  parentId: string | null
  order: number
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

/** Application color theme. `aurora` is the default dark palette. */
export type AppTheme = 'aurora' | 'dawn'

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

/** One-shot natural-language -> shell command translation (non-streaming). */
export interface AITranslateRequest {
  prompt: string
  context?: TerminalContext
}

export interface AITranslateResult {
  content?: string
  error?: string
}

/** A single executed command and its captured output, for result summary. */
export interface CommandRun {
  command: string
  output: string
  /** Shell exit code, or null when it could not be determined. */
  code: number | null
}

/** Ask the AI to evaluate execution results against the original NL request. */
export interface AISummarizeRequest {
  requestId: string
  request: string
  runs: CommandRun[]
  context?: TerminalContext
}

export interface AISummarizeResult {
  content?: string
  error?: string
}

export type SftpEntryType = 'file' | 'dir' | 'link' | 'other'

export interface SftpEntry {
  name: string
  /** Absolute path of the entry. */
  path: string
  type: SftpEntryType
  /** Size in bytes. */
  size: number
  /** Last modified time (ms since epoch). */
  mtime: number
  /** POSIX mode bits. */
  mode: number
}

export interface SftpListResult {
  cwd?: string
  entries?: SftpEntry[]
  error?: string
}

export interface SftpRealpathResult {
  path?: string
  error?: string
}

export interface SftpOpResult {
  ok?: true
  error?: string
}

export interface SftpTransferResult {
  /** Number of files transferred (download is always 0 or 1). */
  count?: number
  /** True when the user cancelled the file dialog. */
  cancelled?: boolean
  error?: string
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
