import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { t } from './i18n'
import { useLocaleStore } from '../store/localeStore'
import { debugLog } from './debugLog'
import type { ConnectionConfig, ConnectOptions } from '../../shared/types'

function loc() {
  return useLocaleStore.getState().locale
}

export interface ConnectArgs {
  opts: ConnectOptions
  title: string
  /** Idle session to dial in place, keeping whichever pane already shows it. */
  terminalId?: string
  /** Empty pane in the active tab to fill, instead of opening a tab. */
  paneId?: string
  /** Saved connection id, recorded on the session so layouts can be rebound. */
  connectionId?: string
}

function genTerminalId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * An idle pane to dial instead of opening a tab.
 *
 * With an explicit id this is a session that asked to be connected — an idle
 * pane's own connect button. Without one it is a blank session in the tab on
 * screen, if there is one: dialling into the tab the user just opened beats
 * leaving it behind and opening another next to it.
 */
function findIdleTerminalToReuse(terminalId?: string): TerminalSession | undefined {
  const store = useSessionsStore.getState()
  if (terminalId) {
    const session = store.sessions.find((s) => s.id === terminalId)
    return session?.status === 'idle' ? session : undefined
  }
  const layout = usePaneLayoutStore.getState()
  const onScreen = layout.visibleTerminalIds()
  const focused = layout.focusedTerminalId()
  // Prefer the pane the user is in over another blank one elsewhere in the tab.
  const candidates = focused ? [focused, ...onScreen.filter((id) => id !== focused)] : onScreen
  for (const id of candidates) {
    const session = store.sessions.find((s) => s.id === id)
    if (session?.status === 'idle') return session
  }
  return undefined
}

/**
 * Give a new session a home, then register it.
 *
 * Placing first means every subscriber's first look at the session already
 * shows where it lives, and `reconcileActiveSession` finds nothing to fix.
 *
 * `paneId` names the pane that asked for the connection. Without one the session
 * fills a vacant pane in the tab on screen — one only exists because the user
 * split to make it — and otherwise gets a tab of its own, as in Windows
 * Terminal.
 */
function placeAndAdd(session: TerminalSession, paneId?: string): void {
  const layout = usePaneLayoutStore.getState()
  if (paneId) {
    layout.showTerminalInPane(paneId, session.id)
  } else {
    layout.placeTerminalAuto(session.id)
  }
  useSessionsStore.getState().addSession(session)
}

/** Open a new tab holding one blank pane, with no SSH session yet. */
export function addEmptyTab(): string {
  const id = genTerminalId()
  // "+" means another tab even when the tab on screen has room to spare.
  usePaneLayoutStore.getState().newTab(id)
  useSessionsStore.getState().addSession({
    id,
    title: t(loc(), 'tabbar.newTab'),
    status: 'idle',
    host: '',
    port: 22,
    username: ''
  })
  return id
}

function resolveConnectOpts(session: TerminalSession): ConnectOptions | undefined {
  if (session.connectOpts) return session.connectOpts
  const port = session.port || 22
  const conn = useBookmarksStore.getState().connections.find(
    (c) => c.host === session.host && c.username === session.username && (c.port || 22) === port
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
 * Open an SSH session for the given options and register a terminal session.
 * Returns an error string on failure, or undefined on success.
 */
export async function connect({
  opts,
  title,
  terminalId,
  paneId,
  connectionId
}: ConnectArgs): Promise<string | undefined> {
  debugLog({
    category: 'user.action',
    message: 'ssh.connect',
    data: { host: opts.host, port: opts.port, username: opts.username, title }
  })
  const store = useSessionsStore.getState()
  const reuse = paneId ? undefined : findIdleTerminalToReuse(terminalId)

  if (reuse) {
    store.setStatusById(reuse.id, 'connecting')
  }

  const result = await window.api.ssh.connect(opts)
  if (result.error || !result.sessionId) {
    const message = result.error ?? t(loc(), 'connect.failed')
    if (reuse) {
      store.setStatusById(reuse.id, 'idle', message)
    }
    return message
  }
  const port = opts.port || 22
  const sessionData = {
    sessionId: result.sessionId,
    title,
    status: 'connected' as const,
    host: opts.host,
    port,
    username: opts.username,
    connectOpts: opts,
    connectionId,
    message: undefined
  }
  if (reuse) {
    store.patchSession(reuse.id, sessionData)
    store.setActive(reuse.id)
  } else {
    placeAndAdd({ id: genTerminalId(), ...sessionData }, paneId)
  }
  return undefined
}

/**
 * Open a local WSL pseudo-terminal session and register it.
 * Returns an error string on failure, or undefined on success.
 */
export async function connectWsl(distro?: string): Promise<string | undefined> {
  debugLog({
    category: 'user.action',
    message: 'wsl.connect',
    data: { distro }
  })
  const store = useSessionsStore.getState()
  const reuse = findIdleTerminalToReuse()
  const title = distro || 'WSL'

  if (reuse) {
    store.setStatusById(reuse.id, 'connecting')
  }

  const result = await window.api.wsl.connect({ distro })
  if (result.error || !result.sessionId) {
    const message = result.error ?? t(loc(), 'connect.failed')
    if (reuse) {
      store.setStatusById(reuse.id, 'idle', message)
    }
    return message
  }

  const sessionData = {
    sessionId: result.sessionId,
    title,
    kind: 'wsl' as const,
    wslDistro: distro,
    status: 'connected' as const,
    host: '',
    port: 0,
    username: '',
    message: undefined
  }
  if (reuse) {
    store.patchSession(reuse.id, sessionData)
    store.setActive(reuse.id)
  } else {
    placeAndAdd({ id: genTerminalId(), ...sessionData })
  }
  return undefined
}

/**
 * Connect using a saved connection config.
 *
 * `into` names a pane or an idle session to dial; without it the connection
 * opens a tab of its own.
 */
export async function connectFromConfig(
  c: ConnectionConfig,
  into?: { terminalId?: string; paneId?: string }
): Promise<string | undefined> {
  const err = await connect({
    opts: {
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password,
      privateKey: c.privateKey,
      passphrase: c.passphrase
    },
    title: c.name || `${c.username}@${c.host}`,
    terminalId: into?.terminalId,
    paneId: into?.paneId,
    connectionId: c.id
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

/** Reopen an existing session in place after disconnect or timeout. */
export async function reconnectSession(terminalId: string): Promise<string | undefined> {
  const store = useSessionsStore.getState()
  const session = store.sessions.find((s) => s.id === terminalId)
  if (!session) return t(loc(), 'connect.tabNotFound')
  if (session.status === 'connecting') return undefined

  if (session.kind === 'wsl') {
    if (session.sessionId) window.api.ssh.close(session.sessionId)
    store.setStatusById(terminalId, 'connecting')
    const result = await window.api.wsl.connect({ distro: session.wslDistro })
    if (result.error || !result.sessionId) {
      const message = result.error ?? t(loc(), 'connect.reconnectFailed')
      store.setStatusById(terminalId, 'error', message)
      return message
    }
    store.updateSession(terminalId, result.sessionId, 'connected')
    return undefined
  }

  const opts = resolveConnectOpts(session)
  if (!opts) {
    return t(loc(), 'connect.noCredentialsReconnect')
  }

  if (session.sessionId) {
    window.api.ssh.close(session.sessionId)
  }
  store.setStatusById(terminalId, 'connecting')

  const result = await window.api.ssh.connect(opts)
  if (result.error || !result.sessionId) {
    const message = result.error ?? t(loc(), 'connect.reconnectFailed')
    store.setStatusById(terminalId, 'error', message)
    return message
  }

  store.updateSession(terminalId, result.sessionId, 'connected')
  if (!session.connectOpts) {
    useSessionsStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === terminalId ? { ...x, connectOpts: opts } : x))
    }))
  }
  return undefined
}

/**
 * Dial the same host again as a second session.
 *
 * Windows Terminal's Duplicate Tab: the copy gets its own tab unless `paneId`
 * asks for a pane in the current one (Duplicate Pane).
 */
export async function duplicateSession(
  terminalId: string,
  paneId?: string
): Promise<string | undefined> {
  const session = useSessionsStore.getState().sessions.find((s) => s.id === terminalId)
  if (!session || session.status !== 'connected') return undefined

  if (session.kind === 'wsl') {
    return connectWsl(session.wslDistro)
  }

  const opts = resolveConnectOpts(session)
  if (!opts) {
    return t(loc(), 'connect.noCredentialsClone')
  }

  return connect({
    opts,
    title: session.title,
    paneId,
    connectionId: session.connectionId
  })
}
