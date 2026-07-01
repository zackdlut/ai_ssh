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
import { useStartupStore } from '../store/startupStore'
import { useSkillsStore } from '../store/skillsStore'
import { useUserRulesStore } from '../store/userRulesStore'
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
  return added.trim()
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
  if (tab.sessionId) window.api.ssh.close(tab.sessionId)
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
    if (t.sessionId) window.api.ssh.close(t.sessionId)
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

async function execCommand(args: Record<string, unknown>): Promise<ToolResult> {
  const tabId = str(args.tab_id)
  const command = str(args.command)
  if (!tabId || !command) return { ok: false, error: 'tab_id and command are required.' }
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab) return { ok: false, error: `No open tab with id "${tabId}".` }
  if (tab.status !== 'connected') {
    return { ok: false, error: `Tab "${tabId}" is not connected (status: ${tab.status}).` }
  }
  const output = await execAndCapture(tab.id, tab.sessionId!, command)
  return { ok: true, result: output || 'Command sent (no output captured).' }
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

async function readSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const name = str(args.name)
  if (!name) return { ok: false, error: 'name is required.' }
  const res = await window.api.skills.read(name)
  if (res.error) return { ok: false, error: res.error }
  return { ok: true, result: res.content || '(empty skill).' }
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
    case 'create_folder':
      return createFolder(args)
    case 'move_connection_to_folder':
      return moveConnectionToFolder(args)
    case 'exec_command':
      return execCommand(args)
    case 'list_ssh_configs':
      return listSshConfigs()
    case 'list_folders':
      return listFolders()
    case 'list_open_tabs':
      return listOpenTabs()
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
 */
export function buildToolContextMessage(): string | undefined {
  const tabs = useTabsStore.getState().tabs
  const configs = useBookmarksStore.getState().connections
  const folders = useBookmarksStore.getState().folders
  const theme = useThemeStore.getState().theme
  const locale = useLocaleStore.getState().locale
  const terminal = useTerminalAppearanceStore.getState()
  const startup = useStartupStore.getState()

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

  const settingsLine = `App settings: theme=${theme} | locale=${locale} | terminal fontSize=${terminal.fontSize} | terminal colorScheme=${terminal.colorScheme} | startup connSidebarOpen=${startup.connSidebarOpen} | startup copilotOpen=${startup.copilotOpen}`

  if (tabs.length === 0 && configs.length === 0 && folders.length === 0) {
    return `Current app state:\n\n${settingsLine}`
  }

  return `Current SSH terminal manager state (use these exact ids with the tools; do NOT invent ids):

Open terminal tabs:
${tabsText}

Saved connection configs:
${configsText}

Bookmark folders:
${foldersText}

${settingsLine}`
}

/**
 * Build the per-turn skill catalog: only each enabled skill's name and
 * description (progressive disclosure). The copilot loads a skill's full
 * instructions on demand with the read_skill tool. Returns undefined when no
 * skills are enabled, so no empty section is injected.
 */
export function buildSkillsContextMessage(): string | undefined {
  const skills = useSkillsStore.getState().skills.filter((s) => s.enabled)
  if (skills.length === 0) return undefined
  const list = skills
    .map((s) => `- ${s.name}: ${s.description || '(no description)'}`)
    .join('\n')
  return `Available skills (reusable instruction packs). When one clearly matches the user's task, call read_skill with its EXACT name to load the full instructions, then follow them. Do NOT invent skill names.

${list}`
}
