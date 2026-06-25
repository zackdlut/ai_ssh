import Store from 'electron-store'
import type { AISettings, BookmarkFolder, ConnectionConfig } from '../../shared/types'

interface StoreSchema {
  ai: AISettings
  connections: ConnectionConfig[]
  folders: BookmarkFolder[]
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
          model: 'qwen3.5:9b'
        },
        connections: [],
        folders: []
      }
    })
  }
  return _store
}

export function getAISettings(): AISettings {
  return store().get('ai')
}

export function setAISettings(settings: AISettings): AISettings {
  store().set('ai', settings)
  return store().get('ai')
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
