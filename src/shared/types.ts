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

export type ModelProfile = 'default' | 'fast' | 'medium' | 'high' | 'custom'

export interface AISettings {
  baseURL: string
  apiKey: string
  /** Model profile used by the AI Copilot sidebar chat. */
  copilotModelProfile: ModelProfile
  /** Model profile used by in-terminal natural-language mode. */
  nlModelProfile: ModelProfile
  /** Model name per profile tier. */
  models: Record<ModelProfile, string>
}

/** Application color theme. `dawn` is the default light palette. */
export type AppTheme = 'aurora' | 'dawn'

export type {
  TerminalAppearanceSettings,
  TerminalColorSchemeId,
  TerminalFontWeight
} from './terminalSettings'

/** UI display language. */
export type AppLocale = 'zh' | 'en'

export interface ChatMessageDTO {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Persisted ECharts replay data for a chart block inside an assistant message. */
export interface ChartSnapshot {
  /** Resolved ChartSpec JSON. */
  spec: string
  /** Serialized ECharts option; present when chart data was captured. */
  option?: string
}

/** A single message in a Copilot chat tab (persisted). */
export interface CopilotChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  thinkingMs?: number
  boundSessionId?: string
  boundTabId?: string
  /** Replay snapshots keyed by chart segment index within the message. */
  chartSnapshots?: Record<string, ChartSnapshot>
}

/** One conversation topic in the Copilot side panel. */
export interface CopilotChatTab {
  id: string
  title: string
  messages: CopilotChatMessage[]
  draft: string
  updatedAt: number
  /** When true, tab is hidden from the tab bar and listed in chat history. */
  archived?: boolean
}

/** Persisted Copilot multi-tab chat state. */
export interface CopilotChatState {
  activeTabId: string
  tabs: CopilotChatTab[]
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

/**
 * Two-phase chart generation: the streaming copilot only emits a short
 * natural-language description of the desired chart; this one-shot request
 * turns that description into a STRICT ChartSpec JSON via the provider's
 * structured-output mode (json_schema, falling back to json_object).
 */
export interface AIChartSpecRequest {
  /** Free-text chart description emitted by the copilot (what/how to plot). */
  description: string
  context?: TerminalContext
}

export interface AIChartSpecResult {
  /** Raw JSON text of the generated chart spec (validated by the renderer). */
  spec?: string
  error?: string
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

export interface SaveFileResult {
  /** Path written when save succeeded. */
  path?: string
  /** True when the user cancelled the file dialog. */
  cancelled?: boolean
  error?: string
}

export interface AIChunkEvent {
  requestId: string
  delta: string
}

/** Streamed reasoning/thinking tokens, kept separate from the answer body. */
export interface AIReasoningEvent {
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

export interface AppInfo {
  name: string
  version: string
  description: string
  author: string
  email: string
  license: string
  electron: string
}
