/**
 * Renderer-side dispatcher for the AI function-calling tools. The agent loop in
 * `aiService` decodes the model's tool calls and routes each one here, where it
 * is executed against the tab store, the bookmarks (saved configs) store, and
 * the SSH bridge. All results are sanitized (never echo secrets back to the
 * model).
 */
import { useTabsStore } from '../store/tabsStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { useThemeStore } from '../store/themeStore'
import { useLocaleStore } from '../store/localeStore'
import { useTerminalAppearanceStore } from '../store/terminalAppearanceStore'
import { connect, connectFromConfig } from './connect'
import { readFullTerminalOutput } from './terminalRegistry'
import { normalizeAISettings } from '../../shared/aiSettings'
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Best-effort capture of a command's output: snapshot the terminal buffer,
 * send the command, wait briefly, then return the newly appended tail. This is
 * not a precise capture (no sentinel markers), but enough for the model to
 * reason about the result.
 */
async function execAndCapture(
  tabId: string,
  sessionId: string,
  command: string
): Promise<string> {
  const before = readFullTerminalOutput(tabId)
  window.api.ssh.write(sessionId, command.replace(/\s+$/, '') + '\n')
  await delay(1500)
  const after = readFullTerminalOutput(tabId)
  const added = after.startsWith(before) ? after.slice(before.length) : after
  return added.trim().slice(-2000)
}

/** The ids of the open terminal tabs, used to detect a newly opened tab. */
function tabIds(): Set<string> {
  return new Set(useTabsStore.getState().tabs.map((t) => t.id))
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

  const newTab = useTabsStore.getState().tabs.find((t) => !before.has(t.id))
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
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab) return { ok: false, error: `No open tab with id "${tabId}".` }
  window.api.ssh.close(tab.sessionId)
  useTabsStore.getState().removeTab(tabId)
  return { ok: true, result: `Closed tab "${tab.title}".` }
}

function closeTabs(args: Record<string, unknown>): ToolResult {
  const all = args.all === true
  const ids = Array.isArray(args.tab_ids) ? args.tab_ids.map((v) => String(v)) : []
  const tabs = useTabsStore.getState().tabs
  const targets = all ? tabs : tabs.filter((t) => ids.includes(t.id))
  if (targets.length === 0) return { ok: false, error: 'No matching tabs to close.' }
  const titles = targets.map((t) => t.title)
  for (const t of targets) {
    window.api.ssh.close(t.sessionId)
    useTabsStore.getState().removeTab(t.id)
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

async function execCommand(args: Record<string, unknown>): Promise<ToolResult> {
  const tabId = str(args.tab_id)
  const command = str(args.command)
  if (!tabId || !command) return { ok: false, error: 'tab_id and command are required.' }
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab) return { ok: false, error: `No open tab with id "${tabId}".` }
  if (tab.status !== 'connected') {
    return { ok: false, error: `Tab "${tabId}" is not connected (status: ${tab.status}).` }
  }
  const output = await execAndCapture(tab.id, tab.sessionId, command)
  return { ok: true, result: output || 'Command sent (no output captured).' }
}

function listSshConfigs(): ToolResult {
  const configs = useBookmarksStore.getState().connections.map(sanitizeConfig)
  return { ok: true, result: JSON.stringify(configs) }
}

function listOpenTabs(): ToolResult {
  const tabs = useTabsStore.getState().tabs.map((t) => ({
    tab_id: t.id,
    title: t.title,
    host: t.host,
    username: t.username,
    port: t.port,
    status: t.status
  }))
  return { ok: true, result: JSON.stringify(tabs) }
}

function sanitizeAISettings(ai: AISettings): Record<string, unknown> {
  return {
    baseURL: ai.baseURL,
    hasApiKey: !!ai.apiKey,
    copilotModelProfile: ai.copilotModelProfile,
    nlModelProfile: ai.nlModelProfile,
    models: { ...ai.models },
    contextLengths: { ...ai.contextLengths }
  }
}

async function readAppSettings(): Promise<Record<string, unknown>> {
  const theme = useThemeStore.getState().theme
  const locale = useLocaleStore.getState().locale
  const terminal = useTerminalAppearanceStore.getState()
  const ai = normalizeAISettings(await window.api.config.getAISettings())
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

  if (updates.ai !== undefined) {
    if (!updates.ai || typeof updates.ai !== 'object') {
      return { ok: false, error: 'ai must be an object.' }
    }
    const aiUpdates = updates.ai as Record<string, unknown>
    const current = normalizeAISettings(await window.api.config.getAISettings())
    const merged: AISettings = { ...current }

    if (typeof aiUpdates.baseURL === 'string') merged.baseURL = aiUpdates.baseURL
    if (typeof aiUpdates.apiKey === 'string') merged.apiKey = aiUpdates.apiKey
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

    await window.api.config.setAISettings(normalizeAISettings(merged))
  }

  const settings = await readAppSettings()
  return { ok: true, result: JSON.stringify(settings) }
}

/** Parse the raw JSON arguments string a model emits for a tool call. */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Dispatch a single tool call to its handler. */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>
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
    case 'exec_command':
      return execCommand(args)
    case 'list_ssh_configs':
      return listSshConfigs()
    case 'list_open_tabs':
      return listOpenTabs()
    case 'get_app_settings':
      return getAppSettings()
    case 'update_app_settings':
      return updateAppSettings(args)
    default:
      return { ok: false, error: `Unknown tool "${name}".` }
  }
}

/**
 * Build a compact, sanitized snapshot of the current open tabs and saved
 * connection configs, injected as a system message each turn so the model can
 * reference tab_id / config_id directly without always calling the list tools.
 */
export function buildToolContextMessage(): string | undefined {
  const tabs = useTabsStore.getState().tabs
  const configs = useBookmarksStore.getState().connections
  const theme = useThemeStore.getState().theme
  const locale = useLocaleStore.getState().locale
  const terminal = useTerminalAppearanceStore.getState()

  const tabsText = tabs.length
    ? tabs
        .map(
          (t) =>
            `- tab_id=${t.id} | ${t.username}@${t.host}:${t.port} | ${t.status}${
              t.id === useTabsStore.getState().activeTabId ? ' | active' : ''
            }`
        )
        .join('\n')
    : '(none)'

  const configsText = configs.length
    ? configs
        .map(
          (c) =>
            `- config_id=${c.id} | ${c.name} | ${c.username}@${c.host}:${c.port}${
              c.password ? ' | has-password' : ''
            }${c.privateKey ? ' | has-key' : ''}`
        )
        .join('\n')
    : '(none)'

  const settingsLine = `App settings: theme=${theme} | locale=${locale} | terminal fontSize=${terminal.fontSize} | terminal colorScheme=${terminal.colorScheme}`

  if (tabs.length === 0 && configs.length === 0) {
    return `Current app state:\n\n${settingsLine}`
  }

  return `Current SSH terminal manager state (use these exact ids with the tools; do NOT invent ids):

Open terminal tabs:
${tabsText}

Saved connection configs:
${configsText}

${settingsLine}`
}
