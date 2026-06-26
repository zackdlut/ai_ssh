import { useTabsStore, type TerminalTab } from '../store/tabsStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import type { ConnectionConfig, ConnectOptions } from '../../shared/types'

export interface ConnectArgs {
  opts: ConnectOptions
  title: string
}

function genTabId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function resolveConnectOpts(tab: TerminalTab): ConnectOptions | undefined {
  if (tab.connectOpts) return tab.connectOpts
  const port = tab.port || 22
  const conn = useBookmarksStore.getState().connections.find(
    (c) => c.host === tab.host && c.username === tab.username && (c.port || 22) === port
  )
  if (!conn) return undefined
  return {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    password: conn.password,
    privateKey: conn.privateKey,
    passphrase: conn.passphrase
  }
}

/**
 * Open an SSH session for the given options and register a terminal tab.
 * Returns an error string on failure, or undefined on success.
 */
export async function connect({ opts, title }: ConnectArgs): Promise<string | undefined> {
  const result = await window.api.ssh.connect(opts)
  if (result.error || !result.sessionId) {
    return result.error ?? 'Failed to connect.'
  }
  const port = opts.port || 22
  useTabsStore.getState().addTab({
    id: genTabId(),
    sessionId: result.sessionId,
    title,
    status: 'connected',
    host: opts.host,
    port,
    username: opts.username,
    connectOpts: opts
  })
  return undefined
}

/** Connect using a saved connection config. */
export async function connectFromConfig(c: ConnectionConfig): Promise<string | undefined> {
  const err = await connect({
    opts: {
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password,
      privateKey: c.privateKey,
      passphrase: c.passphrase
    },
    title: c.name || `${c.username}@${c.host}`
  })
  if (!err) {
    void useBookmarksStore.getState().upsertConnection({
      ...c,
      useCount: (c.useCount ?? 0) + 1,
      lastUsedAt: Date.now()
    })
  }
  return err
}

/** Reopen the SSH session on an existing tab after disconnect or timeout. */
export async function reconnectTab(tabId: string): Promise<string | undefined> {
  const store = useTabsStore.getState()
  const tab = store.tabs.find((t) => t.id === tabId)
  if (!tab) return 'Tab not found.'
  if (tab.status === 'connecting') return undefined

  const opts = resolveConnectOpts(tab)
  if (!opts) {
    return '无法重连：缺少连接凭据，请从侧栏重新连接。'
  }

  window.api.ssh.close(tab.sessionId)
  store.setStatusById(tabId, 'connecting')

  const result = await window.api.ssh.connect(opts)
  if (result.error || !result.sessionId) {
    const message = result.error ?? 'Failed to reconnect.'
    store.setStatusById(tabId, 'error', message)
    return message
  }

  store.updateSession(tabId, result.sessionId, 'connected')
  if (!tab.connectOpts) {
    useTabsStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, connectOpts: opts } : t))
    }))
  }
  return undefined
}

/** Open a new tab with the same SSH connection as an active session. */
export async function cloneTab(tabId: string): Promise<string | undefined> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab || tab.status !== 'connected') return undefined

  const opts = resolveConnectOpts(tab)
  if (!opts) {
    return '无法克隆：缺少连接凭据，请从侧栏重新连接。'
  }

  return connect({ opts, title: tab.title })
}
