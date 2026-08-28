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

/**
 * A stored split layout, as a binary tree. Live session ids are deliberately
 * absent: they do not survive a restart, so a pane remembers the saved
 * connection it should be filled from instead.
 */
export type SavedLayoutNode =
  | { kind: 'leaf'; connectionId?: string }
  | {
      kind: 'split'
      dir: 'row' | 'col'
      ratio: number
      a: SavedLayoutNode
      b: SavedLayoutNode
    }

/**
 * Format of the newest `SavedLayout` this build writes.
 *
 * v1 states what v0 already meant, now that it can be said: one saved layout is
 * a template for one tab. v0 entries carry no `version` and need no conversion —
 * a single tree was all they ever held.
 */
export const SAVED_LAYOUT_VERSION = 1

/**
 * A named workspace: the pane tree for one tab, plus the hosts bound to its
 * panes. Restoring it builds a tab; it does not touch the tabs already open.
 */
export interface SavedLayout {
  id: string
  name: string
  root: SavedLayoutNode
  createdAt: number
  /** Absent on entries written before the field existed, i.e. v0. */
  version?: number
}

/** A bookmark folder used to group saved connections into a nested tree. */
export interface BookmarkFolder {
  id: string
  name: string
  parentId: string | null
  order: number
}

/**
 * File format for transferring saved connections. `xml` is SuperPuTTY's
 * Sessions.XML; `json` is this app's own lossless format.
 */
export type BookmarkTransferFormat = 'xml' | 'json'

/** Outcome of importing saved sessions from an external client's export file. */
export interface ImportSessionsResult {
  /** Connections created by this import. */
  imported?: number
  /** Previously imported connections refreshed from the file. */
  updated?: number
  /** Entries left untouched: duplicates, non-SSH protocols, or missing a host. */
  skipped?: number
  /** Folders created to mirror the source tree. */
  foldersCreated?: number
  /** The file that was read. */
  path?: string
  /** Full bookmark state after the import, so the renderer can refresh. */
  folders?: BookmarkFolder[]
  connections?: ConnectionConfig[]
  /** True when the user dismissed the file picker. */
  cancelled?: boolean
  error?: string
}

/** Outcome of writing saved connections out to an external client's format. */
export interface ExportSessionsResult {
  /** Connections written to the file. */
  exported?: number
  /** The file that was written. */
  path?: string
  /** True when the user dismissed the file picker. */
  cancelled?: boolean
  error?: string
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

/** Result of running a command on its own (non-interactive) SSH channel. */
export interface SshExecResult {
  stdout: string
  stderr: string
  /** Exit status reported by the channel, or null when unavailable. */
  code: number | null
  /** Working directory after the command ran, when it could be determined. */
  cwd?: string
  /** True when the command was killed by the exec timeout. */
  timedOut?: boolean
  /** True when the user interrupted the command. */
  aborted?: boolean
  /** Transport-level failure (channel could not be opened, etc.). */
  error?: string
}

export interface SshExecOptions {
  /** Directory to enter before running the command. */
  cwd?: string
  /** Stall window (ms): timeout if no stdout/stderr arrives for this long. */
  timeoutMs?: number
  /** Wall-clock ceiling (ms) from start, even if the command keeps printing. */
  absoluteMaxMs?: number
}

/**
 * A chart sampler runs a metric collector (vmstat, ping, …) on a channel of its
 * own so its output never touches the user's interactive shell. Chunks stream
 * back keyed by sampler id rather than session id, because one session can back
 * several charts at once.
 */
export interface SamplerDataEvent {
  samplerId: string
  data: string
}

/** The sampler's process exited (normally, on stop, or on transport failure). */
export interface SamplerEndEvent {
  samplerId: string
  error?: string
}

export interface SamplerStartResult {
  error?: string
}

export type ModelProfile = 'default' | 'fast' | 'medium' | 'high' | 'custom'

export interface AISettings {
  /** OpenAI-compatible base URL per profile tier. Empty falls back to `default`. */
  baseURLs: Record<ModelProfile, string>
  /** API key per profile tier. Empty falls back to `default`. */
  apiKeys: Record<ModelProfile, string>
  /** Model profile used by the AI Copilot sidebar chat. */
  copilotModelProfile: ModelProfile
  /** Model profile used by in-terminal natural-language mode. */
  nlModelProfile: ModelProfile
  /** Model name per profile tier. */
  models: Record<ModelProfile, string>
  /** Context window size (tokens) per profile tier. */
  contextLengths: Record<ModelProfile, number>
  /** HTTP(S) proxy URL for AI API requests, e.g. http://127.0.0.1:7890 */
  httpProxy: string
  /** How much the Copilot agent may do without asking for approval. */
  copilotAutonomy: AutonomyMode
  /**
   * Absolute ceiling for a captured or Agent-exec command, in minutes.
   * Output postpones the stall window up to this cap. Default 60.
   */
  commandTimeoutMinutes: number
}

/** How much the agent may do without stopping to ask. See shared/toolPolicy. */
export type AutonomyMode = 'conservative' | 'balanced' | 'autonomous'

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

/**
 * Live state of a delegated sub-agent, mirrored onto its own tool call.
 *
 * A delegation is the longest-running call the app makes — its own bounded LLM
 * loop plus a stream of remote commands — and it used to render as the same
 * anonymous spinner as a directory listing. That is tolerable for one; with
 * several hosts surveyed at once it leaves the user watching identical spinners
 * with no way to tell which machine is slow, which is already answering, and
 * which has not started because the pool is full.
 *
 * Only what the parent could not already read off the final report belongs
 * here: progress through the budget, and the commands as they land.
 */
export interface SubAgentProgressView {
  /** Host label, e.g. `root@prod.example.com:22`. */
  host: string
  /** Tool-calling turns spent so far. */
  step: number
  /** The step budget, so the card can show `3/6` rather than a bare count. */
  maxSteps: number
  /** Commands run so far, in order. */
  commands: string[]
  /** Holding no slot yet: one agent per host, and the pool has a ceiling. */
  queued?: boolean
}

/** A tool call attached to a Copilot assistant message (persisted + rendered). */
export interface ToolCallView {
  id: string
  name: string
  /** Raw JSON-encoded arguments string. */
  args: string
  status: ToolCallStatus
  /** Captured result text fed back to the model (truncated when persisted). */
  result?: string
  /**
   * Compact form of the result used when this call is replayed as part of the
   * conversation on a later user turn. The full `result` can run to thousands
   * of characters, which is fine to show in a card once but ruinous to resend
   * every turn for the rest of the session.
   */
  digest?: string
  error?: string
  /** Elapsed ms while a long-running tool (e.g. exec_command) is in flight. */
  progressMs?: number
  /** Live sub-agent state; only ever set on a `delegate_to_host` call. */
  subAgent?: SubAgentProgressView
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
  /**
   * A provider failure that ended this turn, shown with the message but NEVER
   * replayed to the model.
   *
   * It used to be appended to `content`, which put the app's own diagnostics
   * into the model's mouth: the next turn's history carried "[Error] 500 no
   * user query found in messages" as something the assistant had said, so a
   * request that failed for being too large came back very slightly larger,
   * with the model now also trying to make sense of an error report about
   * itself.
   */
  error?: string
  /** Function/tool calls requested by the model in this assistant turn. */
  toolCalls?: ToolCallView[]
}

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/**
 * The independent check that proves a plan step actually landed.
 *
 * The system prompt has always told the model that a change is confirmed only
 * by a separate check — but that was advice, and a model that skipped the check
 * and declared victory was never contradicted by anything. Attaching the check
 * to the step makes it a claim the harness can test against what really ran, so
 * "restart nginx" cannot be reported as done without an `is-active` in the
 * transcript.
 */
export interface PlanStepVerify {
  /**
   * Command whose execution proves the step. Matched loosely against what the
   * agent actually ran, so an equivalent invocation still counts.
   */
  command: string
  /** Exit code the check must return. Defaults to 0. */
  expectExitCode?: number
  /** Regular expression the check's output must match, when given. */
  expectOutput?: string
}

/**
 * One step of the agent's task plan. The plan is structured rather than prose
 * so it survives history compression, can be re-injected verbatim each turn,
 * and can be rendered as live progress instead of scrolling away.
 */
export interface PlanItem {
  id: string
  title: string
  status: PlanItemStatus
  /** Independent check this step must pass before it may be reported done. */
  verify?: PlanStepVerify
  /**
   * Steps sharing a group number run TOGETHER; groups run in order.
   *
   * A plan used to be strictly linear with exactly one step in progress, which
   * made the most common shape of a multi-host task inexpressible: "collect the
   * same evidence from these three machines" is one step per host, and they have
   * no reason to wait for each other. The model could already run those
   * concurrently — read-only calls in one response go out together — but it had
   * no way to SAY so, so the plan claimed a sequence the execution did not
   * follow, and each `update_plan` had to pick an arbitrary winner to mark
   * in_progress.
   *
   * Groups of concurrent steps rather than a full dependency graph: a DAG invites
   * cycles and orphaned nodes that the harness would then have to diagnose, while
   * "these together, then those" covers the shapes ops work actually takes
   * (survey N hosts in parallel, then analyze, then fix one at a time). Omitted
   * means the step is alone in its own group, which is exactly the old
   * behaviour.
   */
  group?: number
}

/** Copilot loop autonomy for this chat: plan is read-only; agent/execute can mutate. */
export type CopilotAgentMode = 'plan' | 'agent' | 'execute'

/** Coerce persisted / unknown values to a known mode. Missing means Agent. */
export function normalizeCopilotAgentMode(mode: unknown): CopilotAgentMode {
  if (mode === 'plan' || mode === 'execute' || mode === 'agent') return mode
  return 'agent'
}

/** A remote-file backup taken before an agent write, so the user can Restore. */
export interface FileCheckpoint {
  id: string
  /** Terminal tab the backup was written on (SFTP session). */
  terminalTabId: string
  /** Original remote path that was about to be overwritten. */
  path: string
  /** Remote backup path (`<path>.bak.<timestamp>`). */
  backupPath: string
  at: number
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
  /** Current agent task plan for this chat (maintained via the update_plan tool). */
  plan?: PlanItem[]
  /** Terminal tab this chat task is pinned to (task-level, not 1:1 with SSH tabs). */
  pinnedTabId?: string
  /** Display label (`user@host`) kept so a closed pin still has a name. */
  pinnedLabel?: string
  /** Plan vs Agent. Missing on older chats means Agent. */
  agentMode?: CopilotAgentMode
  /** Recent file backups for Restore. Newest last; persist at most a short tail. */
  checkpoints?: FileCheckpoint[]
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
  /** Observed shell working directory on the connected host, when known. */
  cwd?: string
}

export interface AIChatRequest {
  requestId: string
  messages: ChatMessageDTO[]
  context?: TerminalContext
  /** Enable function/tool calling for this request. */
  enableTools?: boolean
  /** Custom user rules injected into the system prompt. */
  userRules?: string
  /**
   * Which optional system-prompt sections to assemble for this turn. Lets the
   * renderer inject the long chart/mermaid rules only when the user asks to
   * visualize/diagram. Tool-dependent sections are decided in main from the
   * tools it actually sends, so they are not carried here.
   */
  promptSections?: {
    chart?: boolean
    mermaid?: boolean
  }
  /**
   * Whether this turn's request is about AI configuration, so the settings tool
   * should carry its heavyweight `ai` branch. Decided in the renderer, which
   * holds the task's opening request and must charge its budget for the same
   * schema main will send.
   */
  aiSettingsIntent?: boolean
  /**
   * Plan mode: main rebuilds the tool list independently of the renderer prompt
   * gate, so this flag must ride on the request or Plan turns still receive
   * write tools.
   */
  planMode?: boolean
  /**
   * Execute mode: drop `exec_command` and always send `run_in_terminal`, even
   * on the core tier. Same reason as `planMode` — main rebuilds tools itself.
   */
  executeMode?: boolean
}

/**
 * One function-calling turn outside the main chat loop, for a delegated host
 * sub-agent.
 *
 * Separate from `AIChatRequest` because everything that request implies is
 * wrong here: no streaming (nothing renders a sub-agent's tokens), no copilot
 * system prompt, no user rules, and a tool surface that must be narrower than
 * any tier. The caller therefore supplies the prompt and the tool names
 * verbatim, and gets the whole turn back as one value.
 */
export interface AIAgentTurnRequest {
  /** Cancellable id, shared with `ai.cancel`. */
  requestId: string
  systemPrompt: string
  messages: ChatMessageDTO[]
  /** Tools to send, by name. Empty/omitted disables function calling. */
  toolNames?: string[]
}

export interface AIAgentTurnResult {
  content?: string
  toolCalls?: ToolCallDTO[]
  usage?: AITokenUsage
  error?: string
}

/** Summarize older Copilot turns before they exceed the context budget. */
export interface AICompressHistoryRequest {
  messages: ChatMessageDTO[]
  context?: TerminalContext
  /**
   * 'chat' summarizes user/assistant turns at a task boundary; 'loop'
   * summarizes an agent's own tool-calling steps mid-task, where the exit codes
   * and file paths matter more than the prose.
   */
  mode?: 'chat' | 'loop'
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

/** Metadata of a remote path, used by the agent's file tools. */
export interface SftpStat {
  size: number
  /** POSIX mode bits. */
  mode: number
  /** Last modified time (ms since epoch). */
  mtime: number
  type: SftpEntryType
}

export interface SftpStatResult {
  stat?: SftpStat
  error?: string
}

/** A bounded byte window of a remote file, decoded as UTF-8. */
export interface SftpReadText {
  text: string
  /** Total size of the file in bytes. */
  size: number
  /** Byte offset this window starts at. */
  startByte: number
  bytesRead: number
  /** True when bytes remain after this window. */
  truncated: boolean
}

export interface SftpReadTextResult {
  read?: SftpReadText
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

/** Result of handing a file to the OS default application. */
export interface OpenPathResult {
  /** Local path that was opened; for a remote file this is the temp copy. */
  path?: string
  error?: string
}

/** Result of opening a URL with the OS default application. */
export interface OpenExternalResult {
  ok?: true
  error?: string
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

/** Token counts reported by the provider for one completed request. */
export interface AITokenUsage {
  prompt: number
  completion: number
  total: number
}

export interface AIDoneEvent {
  requestId: string
  content: string
  /** Tool calls the model requested, when function calling was enabled. */
  toolCalls?: ToolCallDTO[]
  /** Real usage from the provider, when it reports it. */
  usage?: AITokenUsage
  /**
   * The provider's `finish_reason` for this turn. `length` means the reply was
   * CUT at the output limit rather than finished, which the agent loop must not
   * mistake for a considered final answer.
   */
  finishReason?: string
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
