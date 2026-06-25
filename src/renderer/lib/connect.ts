import { useTabsStore } from '../store/tabsStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import type { ConnectionConfig, ConnectOptions } from '../../shared/types'

export interface ConnectArgs {
  opts: ConnectOptions
  title: string
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
  useTabsStore.getState().addTab({
    id: result.sessionId,
    sessionId: result.sessionId,
    title,
    status: 'connected',
    host: opts.host,
    username: opts.username
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
