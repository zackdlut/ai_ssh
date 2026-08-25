import { create } from 'zustand'
import type { ConnectOptions, SshStatus } from '../../shared/types'

/**
 * One terminal session: a pty (local or remote) plus the metadata the UI needs
 * to label and reconnect it. A session is not a tab — tabs own a tree of panes,
 * and each pane shows one of these.
 */
export interface TerminalSession {
  id: string
  title: string
  /** Session backend: remote SSH (default) or a local WSL pseudo-terminal. */
  kind?: 'ssh' | 'wsl'
  /** WSL distribution name for `kind: 'wsl'` sessions (used for reconnect/title). */
  wslDistro?: string
  /** Absent until an SSH session is opened (idle session). */
  sessionId?: string
  status: SshStatus
  host: string
  port: number
  username: string
  message?: string
  /** Credentials used to open (or reopen) this SSH session. */
  connectOpts?: ConnectOptions
  /** Saved connection this session was opened from, so layouts can be rebound. */
  connectionId?: string
  /** Whether the in-terminal natural-language mode is active for this session. */
  nlMode?: boolean
  /** Session-only custom label that overrides the derived title. */
  customTitle?: string
  /** Session-only color marker (any CSS color) shown as a stripe. */
  color?: string
}

interface SessionsState {
  sessions: TerminalSession[]
  activeSessionId: string | null
  addSession: (session: TerminalSession) => void
  removeSession: (id: string) => void
  removeSessions: (ids: string[]) => void
  /** Null while the focused split pane holds no session. */
  setActive: (id: string | null) => void
  setStatusBySession: (sessionId: string, status: SshStatus, message?: string) => void
  setStatusById: (id: string, status: SshStatus, message?: string) => void
  updateSession: (id: string, sessionId: string, status: SshStatus) => void
  setNlMode: (id: string, on: boolean) => void
  toggleNlMode: (id: string) => void
  renameSession: (id: string, title: string) => void
  setSessionColor: (id: string, color?: string) => void
  reorderSession: (fromId: string, toId: string) => void
  patchSession: (id: string, patch: Partial<TerminalSession>) => void
  activeSession: () => TerminalSession | undefined
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  addSession: (session) =>
    set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id })),
  removeSession: (id) =>
    set((s) => {
      const sessions = s.sessions.filter((t) => t.id !== id)
      let activeSessionId = s.activeSessionId
      if (activeSessionId === id) {
        activeSessionId = sessions.length ? sessions[sessions.length - 1].id : null
      }
      return { sessions, activeSessionId }
    }),
  removeSessions: (ids) =>
    set((s) => {
      const drop = new Set(ids)
      const sessions = s.sessions.filter((t) => !drop.has(t.id))
      let activeSessionId = s.activeSessionId
      if (activeSessionId && drop.has(activeSessionId)) {
        activeSessionId = sessions.length ? sessions[sessions.length - 1].id : null
      }
      return { sessions, activeSessionId }
    }),
  setActive: (id) => set({ activeSessionId: id }),
  setStatusBySession: (sessionId, status, message) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.sessionId === sessionId ? { ...t, status, message } : t
      )
    })),
  setStatusById: (id, status, message) =>
    set((s) => ({
      sessions: s.sessions.map((t) => (t.id === id ? { ...t, status, message } : t))
    })),
  updateSession: (id, sessionId, status) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.id === id ? { ...t, sessionId, status, message: undefined } : t
      )
    })),
  setNlMode: (id, on) =>
    set((s) => ({
      sessions: s.sessions.map((t) => (t.id === id ? { ...t, nlMode: on } : t))
    })),
  toggleNlMode: (id) =>
    set((s) => ({
      sessions: s.sessions.map((t) => (t.id === id ? { ...t, nlMode: !t.nlMode } : t))
    })),
  renameSession: (id, title) =>
    set((s) => {
      const trimmed = title.trim()
      return {
        sessions: s.sessions.map((t) =>
          t.id === id ? { ...t, customTitle: trimmed || undefined } : t
        )
      }
    }),
  setSessionColor: (id, color) =>
    set((s) => ({
      sessions: s.sessions.map((t) => (t.id === id ? { ...t, color } : t))
    })),
  reorderSession: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return s
      const from = s.sessions.findIndex((t) => t.id === fromId)
      const to = s.sessions.findIndex((t) => t.id === toId)
      if (from < 0 || to < 0) return s
      const sessions = [...s.sessions]
      const [moved] = sessions.splice(from, 1)
      sessions.splice(to, 0, moved)
      return { sessions }
    }),
  patchSession: (id, patch) =>
    set((s) => ({
      sessions: s.sessions.map((t) => (t.id === id ? { ...t, ...patch } : t))
    })),
  activeSession: () => get().sessions.find((t) => t.id === get().activeSessionId)
}))
