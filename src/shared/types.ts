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

/** A WSL distribution installed on the local Windows machine. */
export interface WslDistro {
  name: string
}

/** Options for opening a local WSL pseudo-terminal session. */
export interface WslConnectOptions {
  /** Distribution to launch; omit to use the default distro. */
  distro?: string
  /** Optional user to launch the shell as (`wsl -u <user>`). */
  user?: string
}

export type SshStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

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
  /** Context window size (tokens) per profile tier. */
  contextLengths: Record<ModelProfile, number>
}

/** Application color theme. `dawn` is the default light palette. */
export type AppTheme = 'aurora' | 'dawn'

export type {
  TerminalAppearanceSettings,
  TerminalColorSchemeId,
  TerminalFontWeight
} from './terminalSettings'

export type { KeybindingId, KeybindingsSettings } from './keybindings'

/** UI display language. */
export type AppLocale = 'zh' | 'en'

/** A single function/tool call requested by the model. */
export interface ToolCallDTO {
  /** Provider-assigned id, echoed back when returning the tool result. */
  id: string
  /** Tool (function) name. */
  name: string
  /** Raw JSON-encoded arguments string. */
  arguments: string
}

export interface ChatMessageDTO {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** For assistant turns that requested tool calls. */
  tool_calls?: ToolCallDTO[]
  /** For role:'tool' messages, the id of the call this result answers. */
  tool_call_id?: string
}

export type ToolCallStatus = 'pending' | 'running' | 'done' | 'rejected' | 'error'

/** A tool call attached to a Copilot assistant message (persisted + rendered). */
export interface ToolCallView {
  id: string
  name: string
  /** Raw JSON-encoded arguments string. */
  args: string
  status: ToolCallStatus
  /** Captured result text fed back to the model (truncated when persisted). */
  result?: string
  error?: string
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
  /** True when this message is a compressed summary of earlier turns. */
  isContextSummary?: boolean
  /** Function/tool calls requested by the model in this assistant turn. */
  toolCalls?: ToolCallView[]
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
  /** Recent terminal output (sliding window of the last N lines). */
  recentOutput: string
  host?: string
  username?: string
  osHint?: string
}

export interface AIChatRequest {
  requestId: string
  messages: ChatMessageDTO[]
  context?: TerminalContext
  /** Enable function/tool calling for this request. */
  enableTools?: boolean
  /** Custom user rules injected into the system prompt. */
  userRules?: string
}

/** Summarize older Copilot turns before they exceed the context budget. */
export interface AICompressHistoryRequest {
  messages: ChatMessageDTO[]
  context?: TerminalContext
}

export interface AICompressHistoryResult {
  summary?: string
  error?: string
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
  /** Per-file errors from batch transfers. */
  errors?: string[]
  error?: string
}

export type LocalEntryType = SftpEntryType

export interface LocalEntry {
  name: string
  path: string
  type: LocalEntryType
  size: number
  mtime: number
}

export interface LocalListResult {
  cwd?: string
  entries?: LocalEntry[]
  error?: string
}

export interface LocalHomeResult {
  path?: string
  error?: string
}

export interface SftpBatchTransferResult {
  count?: number
  errors?: string[]
  error?: string
}

export interface SftpTransferProgress {
  fileName: string
  fileIndex: number
  fileTotal: number
  bytesDone: number
  bytesTotal: number
}

export interface SftpTransferProgressEvent extends SftpTransferProgress {
  transferId: string
  direction: 'upload' | 'download'
}

export interface SftpTransferDoneEvent {
  transferId: string
  direction: 'upload' | 'download'
}

export interface SaveFileResult {
  /** Path written when save succeeded. */
  path?: string
  /** True when the user cancelled the file dialog. */
  cancelled?: boolean
  error?: string
}

export interface PickDirectoryResult {
  path?: string
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
  /** Tool calls the model requested, when function calling was enabled. */
  toolCalls?: ToolCallDTO[]
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
  userDataPath: string
  debugLogDir: string
}

/**
 * An installed Agent Skill: a local folder containing a `SKILL.md` (YAML
 * frontmatter with `name`/`description` + a markdown body of instructions).
 * Only the name+description are shown to the copilot each turn; the full body
 * is loaded on demand via the `read_skill` tool (progressive disclosure).
 */
export interface InstalledSkill {
  id: string
  name: string
  description: string
  /** When false, the skill is hidden from the copilot but kept on disk. */
  enabled: boolean
  /** Absolute path to the copied skill directory under userData/skills/<id>. */
  dir: string
  /** Original source folder the skill was installed from. */
  sourcePath: string
  /** Timestamp (ms) when the skill was installed. */
  installedAt: number
}

/** Result of installing a skill (folder picker may be cancelled). */
export interface SkillInstallResult {
  skill?: InstalledSkill
  /** The full installed-skill list after a successful install. */
  skills?: InstalledSkill[]
  cancelled?: boolean
  error?: string
}

/** Result of reading a skill's full SKILL.md body. */
export interface SkillReadResult {
  content?: string
  error?: string
}
