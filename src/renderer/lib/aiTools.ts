/**
 * Renderer-side dispatcher for the AI function-calling tools. The agent loop in
 * `aiService` decodes the model's tool calls and routes each one here, where it
 * is executed against the tab store, the bookmarks (saved configs) store, and
 * the SSH bridge. All results are sanitized (never echo secrets back to the
 * model).
 */
import { useSessionsStore } from '../store/sessionsStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { useThemeStore } from '../store/themeStore'
import { useLocaleStore } from '../store/localeStore'
import { useTerminalAppearanceStore } from '../store/terminalAppearanceStore'
import { useStartupStore } from '../store/startupStore'
import { useSkillsStore } from '../store/skillsStore'
import { useUserRulesStore } from '../store/userRulesStore'
import { connect, connectFromConfig } from './connect'
import { applyPatch, editFile, globFiles, grepFiles, readFile, writeFile } from './fileTools'
import { gitCommit, gitRead } from './gitTools'
import { updatePlan } from './planTool'
import { formatCaptureElapsed, isSessionCaptureActive, refreshCommandTimeoutMinutes } from './execCapture'
import { runAgentCommand } from './agentExec'
import { isInteractiveTuiCommand } from '../../shared/interactiveCommands'
import { getTabObservation, setTabObservation } from './terminalObservation'
import { snapshotTabMarkers, applyPinnedTabId, formatTerminalLabel } from './pinnedTerminal'
import { readFullTerminalOutput } from './terminalRegistry'
import { formatSubAgentResult, runSubAgent } from './subAgent'
import { withHostLock } from './hostLock'
import { formatScrollbackResult, searchScrollback } from '../../shared/scrollbackSearch'
import {
  describeSource,
  readSource,
  sourceExists,
  type DiffRange,
  type DiffSource
} from './diffSource'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { MIN_SYNC_GROUP, isTerminalReadOnly, usePaneSyncStore } from '../store/paneSyncStore'
import { usePaneMetricsStore } from '../store/paneMetricsStore'
import { collectLeaves } from './paneLayout'
import { verifyCommand } from '../../shared/verify'
import { normalizeAISettings, clampCommandTimeoutMinutes } from '../../shared/aiSettings'
import { normalizeForDiff, toSideBySideRows } from '../../shared/diffRows'
import { computeTextDiff } from '../../shared/textDiff'
import { HOST_MUTATING_TOOLS, toolNamesFor, type ToolTier } from '../../shared/aiTools'
import type { ExecEvidence } from '../../shared/planVerify'
import type { TerminalAppearanceSettings } from '../../shared/terminalSettings'
import type {
  AISettings,
  AppLocale,
  AppTheme,
  ConnectionConfig,
  ModelProfile
} from '../../shared/types'

export interface ToolResult {
  ok: boolean
  /** Result text (JSON or plain) fed back to the model on success. */
  result?: string
  error?: string
  /**
   * The failure looks transient (a timeout, a dropped connection, a resource
   * temporarily unavailable), so the loop may re-run this call once instead of
   * spending a whole model turn to decide the same thing.
   */
  retryable?: boolean
  /** True when the user interrupted the command (terminal Ctrl+C / Stop). */
  aborted?: boolean
}

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Strip secrets from a saved config before returning it to the model. */
function sanitizeConfig(c: ConnectionConfig): Record<string, unknown> {
  return {
    config_id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    hasPassword: !!c.password,
    hasPrivateKey: !!c.privateKey
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** The ids of the open terminal tabs, used to detect a newly opened tab. */
function tabIds(): Set<string> {
  return new Set(useSessionsStore.getState().sessions.map((t) => t.id))
}

async function openSsh(args: Record<string, unknown>): Promise<ToolResult> {
  const configId = str(args.config_id)
  const before = tabIds()

  if (configId) {
    const conn = useBookmarksStore.getState().connections.find((c) => c.id === configId)
    if (!conn) return { ok: false, error: `No saved config with id "${configId}".` }
    const err = await connectFromConfig(conn)
    if (err) return { ok: false, error: err }
  } else {
    const host = str(args.host)
    const username = str(args.username)
    if (!host || !username) {
      return { ok: false, error: 'Provide config_id, or both host and username.' }
    }
    const err = await connect({
      opts: {
        host,
        port: num(args.port) ?? 22,
        username,
        password: str(args.password),
        privateKey: str(args.privateKey)
      },
      title: `${username}@${host}`
    })
    if (err) return { ok: false, error: err }
  }

  const newTab = useSessionsStore.getState().sessions.find((t) => !before.has(t.id))
  return {
    ok: true,
    result: JSON.stringify({
      tab_id: newTab?.id,
      host: newTab?.host,
      username: newTab?.username,
      status: newTab?.status ?? 'connected'
    })
  }
}

function closeTab(args: Record<string, unknown>): ToolResult {
  const tabId = str(args.tab_id)
  if (!tabId) return { ok: false, error: 'tab_id is required.' }
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === tabId)
  if (!tab) return { ok: false, error: `No open tab with id "${tabId}".` }
  if (tab.sessionId) window.api.ssh.close(tab.sessionId)
  useSessionsStore.getState().removeSession(tabId)
  return { ok: true, result: `Closed tab "${tab.title}".` }
}

function closeTabs(args: Record<string, unknown>): ToolResult {
  const all = args.all === true
  const ids = Array.isArray(args.tab_ids) ? args.tab_ids.map((v) => String(v)) : []
  const tabs = useSessionsStore.getState().sessions
  const targets = all ? tabs : tabs.filter((t) => ids.includes(t.id))
  if (targets.length === 0) return { ok: false, error: 'No matching tabs to close.' }
  const titles = targets.map((t) => t.title)
  for (const t of targets) {
    if (t.sessionId) window.api.ssh.close(t.sessionId)
    useSessionsStore.getState().removeSession(t.id)
  }
  return { ok: true, result: `Closed ${targets.length} tab(s): ${titles.join(', ')}.` }
}

async function createSshConfig(args: Record<string, unknown>): Promise<ToolResult> {
  const name = str(args.name)
  const host = str(args.host)
  const username = str(args.username)
  if (!name || !host || !username) {
    return { ok: false, error: 'name, host and username are required.' }
  }
  const conn: ConnectionConfig = {
    id: genId(),
    name,
    host,
    username,
    port: num(args.port) ?? 22,
    password: str(args.password),
    privateKey: str(args.privateKey),
    passphrase: str(args.passphrase)
  }
  await useBookmarksStore.getState().upsertConnection(conn)
  return { ok: true, result: JSON.stringify(sanitizeConfig(conn)) }
}

const UPDATABLE_FIELDS = ['name', 'host', 'username', 'port', 'password', 'privateKey', 'passphrase']

async function updateSshConfig(args: Record<string, unknown>): Promise<ToolResult> {
  const configId = str(args.config_id)
  if (!configId) return { ok: false, error: 'config_id is required.' }
  const updates = (args.updates ?? {}) as Record<string, unknown>
  const conn = useBookmarksStore.getState().connections.find((c) => c.id === configId)
  if (!conn) return { ok: false, error: `No saved config with id "${configId}".` }

  const merged: ConnectionConfig = { ...conn }
  for (const key of Object.keys(updates)) {
    if (!UPDATABLE_FIELDS.includes(key)) continue
    if (key === 'port') {
      const p = num(updates.port)
      if (p !== undefined) merged.port = p
    } else {
      ;(merged as unknown as Record<string, unknown>)[key] = updates[key]
    }
  }
  await useBookmarksStore.getState().upsertConnection(merged)
  return { ok: true, result: JSON.stringify(sanitizeConfig(merged)) }
}

/** Human-readable list of available folders, used in error messages so the model can retry. */
function folderChoices(): string {
  const folders = useBookmarksStore.getState().folders
  if (folders.length === 0) return '(no folders exist yet)'
  return folders.map((f) => `${f.name} (folder_id=${f.id})`).join(', ')
}

const eqName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Resolve a destination folder from an id and/or name. Returns the folder id
 * (or null for the top level). When neither id nor name is given, defaults to
 * the top level. Tolerates the model passing a name in the id field.
 */
function resolveFolder(
  folderIdArg: string | undefined,
  folderNameArg: string | undefined
): { ok: true; folderId: string | null } | { ok: false; error: string } {
  const folders = useBookmarksStore.getState().folders
  if (folderIdArg) {
    const byId = folders.find((f) => f.id === folderIdArg)
    if (byId) return { ok: true, folderId: byId.id }
    // The model sometimes passes a name (or an invented id) in folder_id.
    const byName = folders.filter((f) => eqName(f.name, folderIdArg))
    if (byName.length === 1) return { ok: true, folderId: byName[0].id }
    return {
      ok: false,
      error: `No folder with id "${folderIdArg}". Available folders: ${folderChoices()}. Pass an exact folder_id, or folder_name, or call create_folder first.`
    }
  }
  if (folderNameArg) {
    const byName = folders.filter((f) => eqName(f.name, folderNameArg))
    if (byName.length === 1) return { ok: true, folderId: byName[0].id }
    if (byName.length === 0) {
      return {
        ok: false,
        error: `No folder named "${folderNameArg}". Available folders: ${folderChoices()}. Call create_folder to create it first.`
      }
    }
    return {
      ok: false,
      error: `Multiple folders named "${folderNameArg}". Use folder_id instead: ${byName
        .map((f) => f.id)
        .join(', ')}.`
    }
  }
  return { ok: true, folderId: null }
}

async function createFolder(args: Record<string, unknown>): Promise<ToolResult> {
  const name = str(args.name)
  if (!name) return { ok: false, error: 'name is required.' }
  const store = useBookmarksStore.getState()

  const parent = resolveFolder(str(args.parent_folder_id), str(args.parent_folder_name))
  if (!parent.ok) {
    return {
      ok: false,
      error: `Invalid parent folder. ${parent.error}`
    }
  }
  const parentId = parent.folderId

  // Idempotent: reuse an existing folder with the same name under the same
  // parent instead of creating a duplicate (e.g. when the model retries).
  const existing = store.folders.find(
    (f) => (f.parentId ?? null) === parentId && eqName(f.name, name)
  )
  if (existing) {
    return {
      ok: true,
      result: JSON.stringify({
        folder_id: existing.id,
        name: existing.name,
        parent_folder_id: existing.parentId ?? null,
        existed: true
      })
    }
  }

  const before = new Set(store.folders.map((f) => f.id))
  await store.addFolder(name, parentId)
  const created = useBookmarksStore.getState().folders.find((f) => !before.has(f.id))
  return {
    ok: true,
    result: JSON.stringify({
      folder_id: created?.id,
      name: created?.name ?? name,
      parent_folder_id: created?.parentId ?? null
    })
  }
}

async function moveConnectionToFolder(args: Record<string, unknown>): Promise<ToolResult> {
  const store = useBookmarksStore.getState()

  const configId = str(args.config_id)
  const connName = str(args.connection_name)
  let conn = configId ? store.connections.find((c) => c.id === configId) : undefined
  if (!conn && connName) {
    const matches = store.connections.filter((c) => eqName(c.name, connName))
    if (matches.length === 1) conn = matches[0]
    else if (matches.length > 1) {
      return {
        ok: false,
        error: `Multiple connections named "${connName}". Use config_id: ${matches
          .map((c) => c.id)
          .join(', ')}.`
      }
    }
  }
  if (!conn) {
    if (!configId && !connName) {
      return { ok: false, error: 'config_id (or connection_name) is required.' }
    }
    const choices =
      store.connections.map((c) => `${c.name} (config_id=${c.id})`).join(', ') || '(none)'
    return {
      ok: false,
      error: `No saved connection matching ${
        configId ? `id "${configId}"` : `name "${connName}"`
      }. Available connections: ${choices}.`
    }
  }

  const dest = resolveFolder(str(args.folder_id), str(args.folder_name))
  if (!dest.ok) return { ok: false, error: dest.error }

  await store.move(conn.id, dest.folderId, null)
  const folder = dest.folderId
    ? useBookmarksStore.getState().folders.find((f) => f.id === dest.folderId)
    : null
  return {
    ok: true,
    result: JSON.stringify({
      config_id: conn.id,
      name: conn.name,
      folder_id: dest.folderId,
      folder_name: folder?.name ?? null
    })
  }
}

async function execCommand(
  args: Record<string, unknown>,
  ctx?: ToolExecContext,
  opts?: { visible?: boolean }
): Promise<ToolResult> {
  const tabId = str(args.tab_id)
  const command = str(args.command)
  if (!tabId || !command) return { ok: false, error: 'tab_id and command are required.' }
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === tabId)
  if (!tab) return { ok: false, error: `No open tab with id "${tabId}".` }
  if (tab.status !== 'connected' || !tab.sessionId) {
    return { ok: false, error: `Tab "${tabId}" is not connected (status: ${tab.status}).` }
  }

  if (opts?.visible) {
    if (tab.nlMode) {
      return {
        ok: false,
        error:
          'The terminal is in natural-language (F12) mode. Exit NL mode before running commands in the visible terminal, or switch this chat to Agent mode to use a private channel.'
      }
    }
    if (isTerminalReadOnly(tab.id)) {
      return {
        ok: false,
        error: `Tab "${tabId}" is marked read-only by the user, so nothing may be typed into it. Ask the user to clear read-only, or pick another tab.`
      }
    }
    if (isInteractiveTuiCommand(command)) {
      return {
        ok: false,
        error:
          'Interactive TUIs (vim, nano, less, top, htop, man, tmux, …) cannot run in the visible capture path. Use a non-interactive equivalent (e.g. sed, systemctl status --no-pager, ps) or ask the user to run the TUI themselves.'
      }
    }
    if (isSessionCaptureActive(tab.sessionId)) {
      return {
        ok: false,
        error: `Tab "${tabId}" is still running the previous command. Wait for it to finish before sending another one.`
      }
    }
    // Only when it is off screen — in another pane tab, or hidden behind a
    // zoomed pane. Taking the focused pane on every command would pull the
    // keyboard out of the chat box mid-sentence.
    const layout = usePaneLayoutStore.getState()
    const paneId = layout.paneIdForTerminal(tab.id)
    const zoomed = layout.activeTab().zoomedPaneId
    if (layout.tabIdForTerminal(tab.id) !== layout.activeTabId || (zoomed && zoomed !== paneId)) {
      layout.showTerminal(tab.id)
    }
  }

  const cap = await runAgentCommand(tab, command, {
    onProgress: ctx?.onCaptureProgress,
    onStart: ctx?.onAbortHandle,
    visible: opts?.visible
  })

  // A dropped session mid-command is a recoverable transient failure: surface it
  // as an error (not a "successful" empty result) so the loop can reconnect or
  // ask the user, instead of the model assuming the command succeeded.
  if (cap.disconnected) {
    const detail = cap.error ? ` (${cap.error})` : ''
    return {
      ok: false,
      error: `SSH session for tab "${tabId}" disconnected while running the command${detail}. The command may not have completed; reconnect the tab and retry if needed.`
    }
  }
  if (cap.aborted) {
    const lines: string[] = []
    lines.push('status: interrupted')
    lines.push(`exit_code: ${cap.exitCode === null ? 'unknown' : cap.exitCode}`)
    if (cap.cwd) lines.push(`cwd: ${cap.cwd}`)
    if (cap.waitMs > 0) lines.push(`wait: ${formatCaptureElapsed(cap.waitMs)}`)
    lines.push(
      'note: the user interrupted this command with Ctrl+C before it finished; output may be partial.'
    )
    lines.push('output:')
    lines.push(cap.output || '(no output captured)')
    return { ok: true, result: lines.join('\n'), aborted: true }
  }
  if (cap.busy) {
    return {
      ok: false,
      error: `Tab "${tabId}" is still running another command, so this one was not sent. Retry once it finishes.`
    }
  }

  // Record the observed environment so later turns' snapshot can show it without
  // re-running pwd (Observe: structured cwd + last command + exit code). This
  // also carries the working directory into the NEXT command, which runs on its
  // own channel and would otherwise start back in the login directory.
  setTabObservation(tab.id, {
    cwd: cap.cwd ?? undefined,
    lastCommand: command,
    lastExitCode: cap.exitCode,
    at: Date.now()
  })

  // Verify layer: turn the exit code + output into an explicit signal so the
  // model does not have to guess success/failure from raw text.
  const verdict = verifyCommand(cap.output, cap.exitCode)

  const lines: string[] = []
  lines.push(`status: ${verdict.status}`)
  lines.push(`exit_code: ${cap.exitCode === null ? 'unknown' : cap.exitCode}`)
  if (cap.cwd) lines.push(`cwd: ${cap.cwd}`)
  if (cap.waitMs > 0) lines.push(`wait: ${formatCaptureElapsed(cap.waitMs)}`)
  if (verdict.hint) {
    lines.push(`verify: ${verdict.hint}${verdict.retryable ? ' (transient — a retry may help)' : ''}`)
  }
  if (cap.timedOut) {
    lines.push(
      'note: the command hit its execution timeout and was terminated; output may be partial. Re-run it in the background or narrow its scope.'
    )
  }
  lines.push('output:')
  lines.push(cap.output || '(no output captured)')
  // A transient failure is reported as a successful tool call (the command DID
  // run and its output matters), with the retry hint carried out of band.
  return {
    ok: true,
    result: lines.join('\n'),
    retryable: verdict.status === 'failed' && verdict.retryable
  }
}

/**
 * Search a tab's scrollback. Reads the buffer the app already holds, so the
 * whole session is searchable without paying for it in every turn's context and
 * without re-running anything on the host.
 */
function searchTerminal(args: Record<string, unknown>): ToolResult {
  const tabId = str(args.tab_id)
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  if (!tabId || !pattern.trim()) return { ok: false, error: 'tab_id and pattern are required.' }
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === tabId)
  if (!tab) return { ok: false, error: `No open tab with id "${tabId}".` }

  const buffer = readFullTerminalOutput(tabId)
  const result = searchScrollback(buffer, {
    pattern,
    contextLines: num(args.context_lines),
    maxMatches: num(args.max_matches),
    ignoreCase: args.case_sensitive !== true
  })
  if (result.patternError) {
    return { ok: false, error: formatScrollbackResult(result, { pattern }) }
  }
  return {
    ok: true,
    result: formatScrollbackResult(result, { pattern, label: formatTerminalLabel(tab) })
  }
}

/**
 * Hand one investigation to an isolated sub-agent on another host. The parent
 * gets the report; the sub-agent's own conversation is discarded with it.
 */
async function delegateToHost(
  args: Record<string, unknown>,
  ctx?: ToolExecContext
): Promise<ToolResult> {
  const tabId = str(args.tab_id)
  const task = str(args.task)
  if (!tabId || !task) return { ok: false, error: 'tab_id and task are required.' }
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === tabId)
  if (!tab) return { ok: false, error: `No open tab with id "${tabId}".` }
  if (tab.status !== 'connected' || !tab.sessionId) {
    return { ok: false, error: `Tab "${tabId}" is not connected (status: ${tab.status}).` }
  }

  const outcome = await runSubAgent({
    terminalTabId: tabId,
    task,
    chatTabId: ctx?.chatTabId,
    onAbortHandle: ctx?.onAbortHandle,
    execute: (name, toolArgs, onAbortHandle) =>
      executeToolCall(name, toolArgs, { chatTabId: ctx?.chatTabId, onAbortHandle })
  })
  const text = formatSubAgentResult(formatTerminalLabel(tab), outcome)
  // A sub-agent that could not report is a failed tool call: the parent must not
  // read "no report" as "nothing to report".
  return outcome.ok ? { ok: true, result: text } : { ok: false, error: text }
}

function listSshConfigs(): ToolResult {
  const configs = useBookmarksStore.getState().connections.map(sanitizeConfig)
  return { ok: true, result: JSON.stringify(configs) }
}

function listFolders(): ToolResult {
  const folders = useBookmarksStore.getState().folders.map((f) => ({
    folder_id: f.id,
    name: f.name,
    parent_folder_id: f.parentId ?? null
  }))
  return { ok: true, result: JSON.stringify(folders) }
}

function listOpenTabs(): ToolResult {
  const tabs = useSessionsStore.getState().sessions.map((t) => ({
    tab_id: t.id,
    title: t.title,
    host: t.host,
    username: t.username,
    port: t.port,
    status: t.status
  }))
  return { ok: true, result: JSON.stringify(tabs) }
}

/**
 * Diff two tabs' buffers without touching either host.
 *
 * Reuses `readSource` for the text, `normalizeForDiff` for volatile-value
 * masking, and `computeTextDiff` for the comparison.
 */
function diffPanes(args: Record<string, unknown>): ToolResult {
  const leftTerminalId = typeof args.left_tab_id === 'string' ? args.left_tab_id : ''
  const rightTerminalId = typeof args.right_tab_id === 'string' ? args.right_tab_id : ''
  if (!leftTerminalId || !rightTerminalId) {
    return { ok: false, error: 'left_tab_id and right_tab_id are both required.' }
  }
  if (leftTerminalId === rightTerminalId) {
    return { ok: false, error: 'left_tab_id and right_tab_id must be different tabs.' }
  }

  const range: DiffRange =
    args.range === 'viewport' || args.range === 'all' ? args.range : 'recent'
  const normalize = args.normalize !== false

  const left: DiffSource = { kind: 'terminal', terminalId: leftTerminalId }
  const right: DiffSource = { kind: 'terminal', terminalId: rightTerminalId }
  for (const [id, source] of [
    [leftTerminalId, left],
    [rightTerminalId, right]
  ] as const) {
    if (!sourceExists(source)) return { ok: false, error: `No tab with tab_id "${id}".` }
  }

  const options = normalize
    ? { trimTrailing: true, collapseSpaces: false, maskVolatile: true }
    : { trimTrailing: false, collapseSpaces: false, maskVolatile: false }
  const leftText = normalizeForDiff(readSource(left, range), options)
  const rightText = normalizeForDiff(readSource(right, range), options)

  if (!leftText.trim() && !rightText.trim()) {
    return { ok: false, error: 'Both panes are empty for that range; nothing to compare.' }
  }

  const diff = computeTextDiff(leftText, rightText)
  if (diff.skipped) {
    return {
      ok: false,
      error: 'Too much content to diff line by line. Retry with range="viewport" or "recent".'
    }
  }

  const hunks = toSideBySideRows(diff)
  const header = `--- ${describeSource(left, leftTerminalId)}\n+++ ${describeSource(right, rightTerminalId)}\n+${diff.added} -${diff.removed}`
  if (hunks.length === 0) return { ok: true, result: `${header}\n(identical)` }

  const body: string[] = []
  for (const hunk of hunks) {
    body.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`)
    for (const row of hunk.rows) {
      if (row.left && row.right && row.left.op === 'context') body.push(` ${row.left.text}`)
      else {
        if (row.left) body.push(`-${row.left.text}`)
        if (row.right) body.push(`+${row.right.text}`)
      }
    }
  }
  return { ok: true, result: `${header}\n${body.join('\n')}` }
}

function maskHttpProxy(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.username || parsed.password) {
      return `${parsed.protocol}//[REDACTED]@${parsed.host}`
    }
    return trimmed
  } catch {
    return '[REDACTED]'
  }
}

function sanitizeAISettings(ai: AISettings): Record<string, unknown> {
  return {
    baseURL: ai.baseURLs.default,
    hasApiKey: !!ai.apiKeys.default,
    httpProxy: maskHttpProxy(ai.httpProxy),
    copilotModelProfile: ai.copilotModelProfile,
    nlModelProfile: ai.nlModelProfile,
    models: { ...ai.models },
    contextLengths: { ...ai.contextLengths },
    commandTimeoutMinutes: ai.commandTimeoutMinutes
  }
}

async function readAppSettings(): Promise<Record<string, unknown>> {
  const theme = useThemeStore.getState().theme
  const locale = useLocaleStore.getState().locale
  const terminal = useTerminalAppearanceStore.getState()
  const startup = useStartupStore.getState()
  const ai = normalizeAISettings(await window.api.config.getAISettings())
  const user_rules = useUserRulesStore.getState().rules
  return {
    theme,
    locale,
    terminal_appearance: {
      colorScheme: terminal.colorScheme,
      fontFamily: terminal.fontFamily,
      fontSize: terminal.fontSize,
      lineHeight: terminal.lineHeight,
      fontWeight: terminal.fontWeight
    },
    startup: {
      connSidebarOpen: startup.connSidebarOpen,
      copilotOpen: startup.copilotOpen
    },
    user_rules,
    ai: sanitizeAISettings(ai)
  }
}

function isAppTheme(v: unknown): v is AppTheme {
  return v === 'aurora' || v === 'dawn'
}

function isAppLocale(v: unknown): v is AppLocale {
  return v === 'zh' || v === 'en'
}

function isModelProfile(v: unknown): v is ModelProfile {
  return v === 'default' || v === 'fast' || v === 'medium' || v === 'high' || v === 'custom'
}

async function getAppSettings(): Promise<ToolResult> {
  const settings = await readAppSettings()
  return { ok: true, result: JSON.stringify(settings) }
}

async function updateAppSettings(args: Record<string, unknown>): Promise<ToolResult> {
  const updates = (args.updates ?? {}) as Record<string, unknown>
  if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    return { ok: false, error: 'updates object with at least one field is required.' }
  }

  if (updates.theme !== undefined) {
    if (!isAppTheme(updates.theme)) {
      return { ok: false, error: 'theme must be "aurora" or "dawn".' }
    }
    await useThemeStore.getState().setTheme(updates.theme)
  }

  if (updates.locale !== undefined) {
    if (!isAppLocale(updates.locale)) {
      return { ok: false, error: 'locale must be "zh" or "en".' }
    }
    await useLocaleStore.getState().setLocale(updates.locale)
  }

  if (updates.terminal_appearance !== undefined) {
    if (!updates.terminal_appearance || typeof updates.terminal_appearance !== 'object') {
      return { ok: false, error: 'terminal_appearance must be an object.' }
    }
    await useTerminalAppearanceStore
      .getState()
      .set(updates.terminal_appearance as Partial<TerminalAppearanceSettings>)
  }

  if (updates.startup !== undefined) {
    if (!updates.startup || typeof updates.startup !== 'object') {
      return { ok: false, error: 'startup must be an object.' }
    }
    const startupUpdates = updates.startup as Record<string, unknown>
    const startupStore = useStartupStore.getState()
    if (typeof startupUpdates.connSidebarOpen === 'boolean') {
      startupStore.setConnSidebarOpen(startupUpdates.connSidebarOpen)
    }
    if (typeof startupUpdates.copilotOpen === 'boolean') {
      startupStore.setCopilotOpen(startupUpdates.copilotOpen)
    }
  }

  if (updates.user_rules !== undefined) {
    if (typeof updates.user_rules !== 'string') {
      return { ok: false, error: 'user_rules must be a string.' }
    }
    await useUserRulesStore.getState().setRules(updates.user_rules)
  }

  if (updates.ai !== undefined) {
    if (!updates.ai || typeof updates.ai !== 'object') {
      return { ok: false, error: 'ai must be an object.' }
    }
    const aiUpdates = updates.ai as Record<string, unknown>
    const current = normalizeAISettings(await window.api.config.getAISettings())
    const merged: AISettings = {
      ...current,
      baseURLs: { ...current.baseURLs },
      apiKeys: { ...current.apiKeys },
      models: { ...current.models },
      contextLengths: { ...current.contextLengths }
    }

    // Scalar baseURL/apiKey target the `default` profile; per-profile records
    // (baseURLs/apiKeys) let the model set any tier.
    if (typeof aiUpdates.baseURL === 'string') merged.baseURLs.default = aiUpdates.baseURL
    if (typeof aiUpdates.apiKey === 'string') merged.apiKeys.default = aiUpdates.apiKey
    if (typeof aiUpdates.httpProxy === 'string') merged.httpProxy = aiUpdates.httpProxy
    if (aiUpdates.baseURLs && typeof aiUpdates.baseURLs === 'object') {
      const urls = aiUpdates.baseURLs as Record<string, unknown>
      for (const key of Object.keys(urls)) {
        if (isModelProfile(key) && typeof urls[key] === 'string') {
          merged.baseURLs[key] = urls[key] as string
        }
      }
    }
    if (aiUpdates.apiKeys && typeof aiUpdates.apiKeys === 'object') {
      const keys = aiUpdates.apiKeys as Record<string, unknown>
      for (const key of Object.keys(keys)) {
        if (isModelProfile(key) && typeof keys[key] === 'string') {
          merged.apiKeys[key] = keys[key] as string
        }
      }
    }
    if (isModelProfile(aiUpdates.copilotModelProfile)) {
      merged.copilotModelProfile = aiUpdates.copilotModelProfile
    }
    if (isModelProfile(aiUpdates.nlModelProfile)) {
      merged.nlModelProfile = aiUpdates.nlModelProfile
    }

    if (aiUpdates.models && typeof aiUpdates.models === 'object') {
      const models = aiUpdates.models as Record<string, unknown>
      for (const key of Object.keys(models)) {
        if (isModelProfile(key) && typeof models[key] === 'string') {
          merged.models[key] = models[key]
        }
      }
    }

    if (aiUpdates.contextLengths && typeof aiUpdates.contextLengths === 'object') {
      const lengths = aiUpdates.contextLengths as Record<string, unknown>
      for (const key of Object.keys(lengths)) {
        if (isModelProfile(key)) {
          const n = num(lengths[key])
          if (n !== undefined) merged.contextLengths[key] = n
        }
      }
    }

    if (aiUpdates.commandTimeoutMinutes !== undefined) {
      merged.commandTimeoutMinutes = clampCommandTimeoutMinutes(aiUpdates.commandTimeoutMinutes)
    }

    const saved = await window.api.config.setAISettings(normalizeAISettings(merged))
    refreshCommandTimeoutMinutes(saved.commandTimeoutMinutes)
  }

  const settings = await readAppSettings()
  return { ok: true, result: JSON.stringify(settings) }
}

async function readSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const name = str(args.name)
  if (!name) return { ok: false, error: 'name is required.' }
  const res = await window.api.skills.read(name)
  if (res.error) return { ok: false, error: res.error }
  return { ok: true, result: res.content || '(empty skill).' }
}

export type ParsedToolArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Parse the raw JSON arguments string a model emits for a tool call.
 *
 * Malformed JSON used to fall back to `{}`, so the model was told "tab_id is
 * required" for a call where it HAD passed tab_id — and it would faithfully
 * re-send the same broken JSON. Reporting the parse failure verbatim is the
 * only feedback that leads to a corrected retry.
 */
export function parseToolArgs(raw: string): ParsedToolArgs {
  if (!raw || !raw.trim()) return { ok: true, args: {} }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error: `Tool arguments must be a JSON object, received: ${raw}. Re-emit the call with valid JSON.`
      }
    }
    return { ok: true, args: parsed as Record<string, unknown> }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: `Invalid JSON arguments (${detail}): ${raw}. Re-emit the call with valid JSON.`
    }
  }
}

export interface ToolExecContext {
  /** Chat tab the call belongs to; needed by chat-scoped tools like update_plan. */
  chatTabId?: string
  /** Terminal tab this chat is pinned to; host tools omit tab_id against it. */
  pinnedTabId?: string
  /** Commands this task has run, for checking plan verify assertions against. */
  execEvidence?: readonly ExecEvidence[]
  onCaptureProgress?: (elapsedMs: number) => void
  /** Receives a canceller once a long-running command starts, for Stop. */
  onAbortHandle?: (abort: () => void) => void
}

/**
 * Dispatch a single tool call to its handler.
 *
 * Calls that CHANGE a host are serialized per terminal tab: chat tabs now run
 * their loops in parallel, so two of them pinned to the same machine can reach
 * it in the same instant. Reads are left to overlap — they are the common case
 * and cannot corrupt anything. `delegate_to_host` deliberately takes no lock:
 * it spans many turns, and its own inner calls take the lock individually.
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolExecContext
): Promise<ToolResult> {
  args = applyPinnedTabId(name, args, ctx?.pinnedTabId)
  if (!HOST_MUTATING_TOOLS.has(name)) return dispatchToolCall(name, args, ctx)
  const hostKey = typeof args.tab_id === 'string' ? args.tab_id.trim() : ''
  return withHostLock(hostKey, () => dispatchToolCall(name, args, ctx))
}

async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolExecContext
): Promise<ToolResult> {
  switch (name) {
    case 'open_ssh':
      return openSsh(args)
    case 'close_tab':
      return closeTab(args)
    case 'close_tabs':
      return closeTabs(args)
    case 'create_ssh_config':
      return createSshConfig(args)
    case 'update_ssh_config':
      return updateSshConfig(args)
    case 'create_folder':
      return createFolder(args)
    case 'move_connection_to_folder':
      return moveConnectionToFolder(args)
    case 'exec_command':
      return execCommand(args, ctx)
    case 'run_in_terminal':
      return execCommand(args, ctx, { visible: true })
    case 'search_terminal':
      return searchTerminal(args)
    case 'delegate_to_host':
      return delegateToHost(args, ctx)
    case 'read_file':
      return readFile(args)
    case 'edit_file':
      return editFile(args, ctx)
    case 'apply_patch':
      return applyPatch(args, ctx)
    case 'write_file':
      return writeFile(args, ctx)
    case 'grep':
      return grepFiles(args)
    case 'glob':
      return globFiles(args)
    case 'git_read':
      return gitRead(args)
    case 'git_commit':
      return gitCommit(args)
    case 'update_plan':
      return updatePlan(ctx?.chatTabId, args, ctx?.execEvidence)
    case 'list_ssh_configs':
      return listSshConfigs()
    case 'list_folders':
      return listFolders()
    case 'list_open_tabs':
      return listOpenTabs()
    case 'diff_panes':
      return diffPanes(args)
    case 'get_app_settings':
      return getAppSettings()
    case 'update_app_settings':
      return updateAppSettings(args)
    case 'read_skill':
      return readSkill(args)
    default:
      return { ok: false, error: `Unknown tool "${name}".` }
  }
}

/**
 * Build a compact, sanitized snapshot of the current open tabs and saved
 * connection configs, injected as a system message each turn so the model can
 * reference tab_id / config_id directly without always calling the list tools.
 *
 * Scoped to the tools the turn actually sends. Ids and settings the turn has no
 * tool to consume are not context, they are noise the model pays for on every
 * turn: on the `core` tier nothing accepts a config_id or folder_id, and nothing
 * reads or writes app settings. Gating on tool presence rather than on the tier
 * name means widening a tier automatically brings the matching facts back.
 */
/**
 * The split grid, as the user currently sees it.
 *
 * This belongs in the tool snapshot rather than in `TerminalContext`: that
 * describes the one session a question is about, while the layout is what makes
 * "compare the left and right panes" resolvable to ids.
 *
 * Only the tab on screen is laid out, since that is what "left" and "right"
 * refer to. The other tabs are reported as a count, so the model can tell that
 * the tab list above holds sessions no pane position names — without it, "the
 * other pane" would silently resolve to something in a tab nobody is looking at.
 */
function buildPaneLayoutText(): string | undefined {
  const layout = usePaneLayoutStore.getState()
  const active = layout.activeTab()
  const leaves = collectLeaves(active.root)
  const otherTabs = layout.tabs.length - 1
  // One unsplit pane in the only tab adds nothing over the session list.
  if (leaves.length < 2 && otherTabs === 0) return undefined

  const sync = usePaneSyncStore.getState()
  const sizes = usePaneMetricsStore.getState().sizes
  const sessions = useSessionsStore.getState().sessions

  const lines = leaves.map((leaf, index) => {
    const session = leaf.terminalId ? sessions.find((s) => s.id === leaf.terminalId) : undefined
    if (!session) {
      const pending = leaf.pendingConnectionId ? ' | awaiting connection' : ''
      return `- pane ${index + 1}: (empty)${pending}`
    }
    const size = sizes[session.id]
    const flags = [
      sync.lockedTerminalIds.includes(session.id) ? 'locked' : '',
      sync.readOnlyTerminalIds.includes(session.id) ? 'read-only' : '',
      active.zoomedPaneId === leaf.id ? 'zoomed' : '',
      active.focusedPaneId === leaf.id ? 'focused' : ''
    ].filter(Boolean)
    return `- pane ${index + 1}: tab_id=${session.id} | ${session.username}@${session.host}${
      size ? ` | ${size.cols}x${size.rows}` : ''
    }${flags.length ? ` | ${flags.join(', ')}` : ''}`
  })

  const group =
    sync.lockedTerminalIds.length >= MIN_SYNC_GROUP
      ? `\nSync group: ${sync.lockedTerminalIds.length} panes locked, scrolling together (input=${
          sync.syncInput ? 'on' : 'off'
        })`
      : ''

  const elsewhere = otherTabs
    ? `\n${otherTabs} other tab${otherTabs > 1 ? 's' : ''} hold sessions that are open but off screen; those have no pane number here.`
    : ''

  return `${lines.join('\n')}${group}${elsewhere}`
}

export function buildToolContextMessage(
  /** Tier whose tools this turn sends, or undefined when tools are disabled. */
  tier: ToolTier | undefined,
  /** Terminal tab the current chat task is pinned to. */
  pinnedTabId?: string
): string | undefined {
  // A turn with no tools can act on no id, so the whole snapshot is dead weight.
  if (!tier) return undefined
  const available = new Set(toolNamesFor(tier, { hasSkills: hasEnabledSkills() }))
  const wantsConnections = ['open_ssh', 'create_ssh_config', 'update_ssh_config', 'list_ssh_configs', 'move_connection_to_folder'].some(
    (n) => available.has(n)
  )
  const wantsFolders = ['create_folder', 'list_folders', 'move_connection_to_folder'].some((n) =>
    available.has(n)
  )
  const wantsSettings = available.has('get_app_settings') || available.has('update_app_settings')

  const tabs = useSessionsStore.getState().sessions
  const configs = wantsConnections ? useBookmarksStore.getState().connections : []
  const folders = wantsFolders || wantsConnections ? useBookmarksStore.getState().folders : []
  const theme = useThemeStore.getState().theme
  const locale = useLocaleStore.getState().locale
  const terminal = useTerminalAppearanceStore.getState()
  const startup = useStartupStore.getState()

  const activeSessionId = useSessionsStore.getState().activeSessionId
  const tabsText = tabs.length
    ? tabs
        .map((t) => {
          const obs = getTabObservation(t.id)
          const cwd = obs?.cwd ? ` | cwd=${obs.cwd}` : ''
          const last =
            obs?.lastCommand !== undefined
              ? ` | last=\`${obs.lastCommand}\`${
                  obs.lastExitCode === null || obs.lastExitCode === undefined
                    ? ''
                    : ` (exit ${obs.lastExitCode})`
                }`
              : ''
          return `- tab_id=${t.id} | ${t.username}@${t.host}:${t.port} | ${t.status}${
            snapshotTabMarkers(t.id, activeSessionId, pinnedTabId)
          }${cwd}${last}`
        })
        .join('\n')
    : '(none)'

  const folderName = (id?: string | null): string | undefined =>
    id ? folders.find((f) => f.id === id)?.name : undefined

  const configsText = configs.length
    ? configs
        .map((c) => {
          const parent = folderName(c.parentId)
          return `- config_id=${c.id} | ${c.name} | ${c.username}@${c.host}:${c.port}${
            c.password ? ' | has-password' : ''
          }${c.privateKey ? ' | has-key' : ''}${
            parent ? ` | folder=${parent} (folder_id=${c.parentId})` : ' | folder=(top level)'
          }`
        })
        .join('\n')
    : '(none)'

  const foldersText = folders.length
    ? folders
        .map((f) => {
          const parent = folderName(f.parentId)
          return `- folder_id=${f.id} | ${f.name}${
            parent ? ` | parent=${parent} (folder_id=${f.parentId})` : ' | parent=(top level)'
          }`
        })
        .join('\n')
    : '(none)'

  const settingsLine = wantsSettings
    ? `App settings: theme=${theme} | locale=${locale} | terminal fontSize=${terminal.fontSize} | terminal colorScheme=${terminal.colorScheme} | startup connSidebarOpen=${startup.connSidebarOpen} | startup copilotOpen=${startup.copilotOpen}`
    : undefined

  const panesText = buildPaneLayoutText()

  const sections = [
    `Open terminal tabs:\n${tabsText}`,
    panesText && `Panes in the tab on screen:\n${panesText}`,
    wantsConnections && `Saved connection configs:\n${configsText}`,
    wantsFolders && `Bookmark folders:\n${foldersText}`,
    settingsLine
  ].filter((s): s is string => !!s)

  if (tabs.length === 0 && !configs.length && !folders.length) {
    return settingsLine ? `Current app state:\n\n${settingsLine}` : undefined
  }

  return `Current SSH terminal manager state (use these exact ids with the tools; do NOT invent ids):\n\n${sections.join('\n\n')}`
}

/**
 * Build the per-turn skill catalog: only each enabled skill's name and
 * description (progressive disclosure). The copilot loads a skill's full
 * instructions on demand with the read_skill tool. Returns undefined when no
 * skills are enabled, so no empty section is injected.
 */
/**
 * Whether any skill is installed and enabled. Decides whether the read_skill
 * schema and the prompt paragraphs about skills are worth sending at all, so it
 * must be asked before assembling either.
 */
export function hasEnabledSkills(): boolean {
  return useSkillsStore.getState().skills.some((s) => s.enabled)
}

export function buildSkillsContextMessage(): string | undefined {
  const skills = useSkillsStore.getState().skills.filter((s) => s.enabled)
  if (skills.length === 0) return undefined
  const list = skills
    .map((s) => `- ${s.name}: ${s.description || '(no description)'}`)
    .join('\n')
  return `Available skills (reusable instruction packs). When one clearly matches the user's task, call read_skill with its EXACT name to load the full instructions, then follow them. Do NOT invent skill names.

${list}`
}
