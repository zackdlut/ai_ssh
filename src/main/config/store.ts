import Store from 'electron-store'
import { DEFAULT_MODELS, DEFAULT_CONTEXT_LENGTHS, cloneModels, cloneContextLengths, normalizeAISettings } from '../../shared/aiSettings'
import {
  DEFAULT_TERMINAL_APPEARANCE,
  normalizeTerminalAppearanceSettings
} from '../../shared/terminalSettings'
import type { TerminalAppearanceSettings } from '../../shared/terminalSettings'
import type {
  AISettings,
  AppLocale,
  AppTheme,
  BookmarkFolder,
  ConnectionConfig,
  CopilotChatState
} from '../../shared/types'

interface StoreSchema {
  ai: AISettings
  theme: AppTheme
  locale: AppLocale
  terminalAppearance: TerminalAppearanceSettings
  connections: ConnectionConfig[]
  folders: BookmarkFolder[]
  copilotChats: CopilotChatState | null
}

let _store: Store<StoreSchema> | null = null

/**
 * Lazily create the store so it is only instantiated after the Electron app is
 * ready and `app.getPath('userData')` resolves correctly.
 */
function store(): Store<StoreSchema> {
  if (!_store) {
    _store = new Store<StoreSchema>({
      defaults: {
        ai: {
          // Ollama exposes an OpenAI-compatible API under /v1.
          baseURL: 'http://10.67.34.44:11434/v1',
          apiKey: 'ollam',
          copilotModelProfile: 'default',
          nlModelProfile: 'fast',
          models: { ...DEFAULT_MODELS },
          contextLengths: { ...DEFAULT_CONTEXT_LENGTHS }
        },
        theme: 'dawn',
        locale: 'zh',
        terminalAppearance: { ...DEFAULT_TERMINAL_APPEARANCE },
        connections: [],
        folders: [],
        copilotChats: null
      }
    })
  }
  return _store
}

export function getAISettings(): AISettings {
  return normalizeAISettings(store().get('ai'))
}

export function setAISettings(settings: AISettings): AISettings {
  const normalized = normalizeAISettings(settings)
  store().set('ai', {
    ...normalized,
    models: cloneModels(normalized.models),
    contextLengths: cloneContextLengths(normalized.contextLengths)
  })
  return getAISettings()
}

export function getTheme(): AppTheme {
  const theme = store().get('theme')
  return theme === 'aurora' ? 'aurora' : 'dawn'
}

export function setTheme(theme: AppTheme): AppTheme {
  store().set('theme', theme === 'aurora' ? 'aurora' : 'dawn')
  return getTheme()
}

export function getLocale(): AppLocale {
  const locale = store().get('locale')
  return locale === 'en' ? 'en' : 'zh'
}

export function setLocale(locale: AppLocale): AppLocale {
  store().set('locale', locale === 'en' ? 'en' : 'zh')
  return getLocale()
}

export function getTerminalAppearance(): TerminalAppearanceSettings {
  return normalizeTerminalAppearanceSettings(store().get('terminalAppearance'))
}

export function setTerminalAppearance(
  settings: TerminalAppearanceSettings
): TerminalAppearanceSettings {
  const normalized = normalizeTerminalAppearanceSettings(settings)
  store().set('terminalAppearance', normalized)
  return getTerminalAppearance()
}

export function getConnections(): ConnectionConfig[] {
  return store().get('connections')
}

export function saveConnection(conn: ConnectionConfig): ConnectionConfig[] {
  const list = store().get('connections')
  const idx = list.findIndex((c) => c.id === conn.id)
  if (idx >= 0) {
    list[idx] = conn
  } else {
    list.push(conn)
  }
  store().set('connections', list)
  return list
}

export function deleteConnection(id: string): ConnectionConfig[] {
  const list = store().get('connections').filter((c) => c.id !== id)
  store().set('connections', list)
  return list
}

export function setConnections(list: ConnectionConfig[]): ConnectionConfig[] {
  store().set('connections', list)
  return list
}

export function getFolders(): BookmarkFolder[] {
  return store().get('folders')
}

export function saveFolder(folder: BookmarkFolder): BookmarkFolder[] {
  const list = store().get('folders')
  const idx = list.findIndex((f) => f.id === folder.id)
  if (idx >= 0) {
    list[idx] = folder
  } else {
    list.push(folder)
  }
  store().set('folders', list)
  return list
}

export function setFolders(list: BookmarkFolder[]): BookmarkFolder[] {
  store().set('folders', list)
  return list
}

/**
 * Delete a folder and its entire subtree of folders. Connections that lived
 * directly or indirectly inside the removed folders are detached to the root
 * (parentId = null) instead of being destroyed.
 */
export function getCopilotChats(): CopilotChatState | null {
  return store().get('copilotChats')
}

export function setCopilotChats(state: CopilotChatState | null): CopilotChatState | null {
  store().set('copilotChats', state)
  return getCopilotChats()
}

export function deleteFolder(id: string): {
  folders: BookmarkFolder[]
  connections: ConnectionConfig[]
} {
  const folders = store().get('folders')
  const removed = new Set<string>()
  const collect = (folderId: string): void => {
    removed.add(folderId)
    for (const f of folders) {
      if (f.parentId === folderId) collect(f.id)
    }
  }
  collect(id)

  const nextFolders = folders.filter((f) => !removed.has(f.id))
  const connections = store().get('connections').map((c) =>
    c.parentId && removed.has(c.parentId) ? { ...c, parentId: null } : c
  )

  store().set('folders', nextFolders)
  store().set('connections', connections)
  return { folders: nextFolders, connections }
}
