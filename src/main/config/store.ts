import Store from 'electron-store'
import type { AISettings, ConnectionConfig } from '../../shared/types'

interface StoreSchema {
  ai: AISettings
  connections: ConnectionConfig[]
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
        connections: []
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
