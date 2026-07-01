import { create } from 'zustand'
import type { ConnectOptions, SshStatus } from '../../shared/types'

export interface TerminalTab {
  id: string
  title: string
  sessionId: string
  status: SshStatus
  host: string
  port: number
  username: string
  message?: string
  /** Credentials used to open (or reopen) this tab's SSH session. */
  connectOpts?: ConnectOptions
  /** Whether the in-terminal natural-language mode is active for this tab. */
  nlMode?: boolean
  /** Session-only custom label that overrides the derived title. */
  customTitle?: string
  /** Session-only color marker (any CSS color) shown as a stripe. */
  color?: string
}

interface TabsState {
  tabs: TerminalTab[]
  activeTabId: string | null
  addTab: (tab: TerminalTab) => void
  removeTab: (id: string) => void
  removeTabs: (ids: string[]) => void
  setActive: (id: string) => void
  setStatusBySession: (sessionId: string, status: SshStatus, message?: string) => void
  setStatusById: (id: string, status: SshStatus, message?: string) => void
  updateSession: (id: string, sessionId: string, status: SshStatus) => void
  setNlMode: (id: string, on: boolean) => void
  toggleNlMode: (id: string) => void
  renameTab: (id: string, title: string) => void
  setTabColor: (id: string, color?: string) => void
  reorderTab: (fromId: string, toId: string) => void
  activeTab: () => TerminalTab | undefined
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  addTab: (tab) =>
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id })),
  removeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      let activeTabId = s.activeTabId
      if (activeTabId === id) {
        activeTabId = tabs.length ? tabs[tabs.length - 1].id : null
      }
      return { tabs, activeTabId }
    }),
  removeTabs: (ids) =>
    set((s) => {
      const drop = new Set(ids)
      const tabs = s.tabs.filter((t) => !drop.has(t.id))
      let activeTabId = s.activeTabId
      if (activeTabId && drop.has(activeTabId)) {
        activeTabId = tabs.length ? tabs[tabs.length - 1].id : null
      }
      return { tabs, activeTabId }
    }),
  setActive: (id) => set({ activeTabId: id }),
  setStatusBySession: (sessionId, status, message) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === sessionId ? { ...t, status, message } : t
      )
    })),
  setStatusById: (id, status, message) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, status, message } : t))
    })),
  updateSession: (id, sessionId, status) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, sessionId, status, message: undefined } : t
      )
    })),
  setNlMode: (id, on) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, nlMode: on } : t))
    })),
  toggleNlMode: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, nlMode: !t.nlMode } : t))
    })),
  renameTab: (id, title) =>
    set((s) => {
      const trimmed = title.trim()
      return {
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, customTitle: trimmed || undefined } : t
        )
      }
    }),
  setTabColor: (id, color) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, color } : t))
    })),
  reorderTab: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return s
      const from = s.tabs.findIndex((t) => t.id === fromId)
      const to = s.tabs.findIndex((t) => t.id === toId)
      if (from < 0 || to < 0) return s
      const tabs = [...s.tabs]
      const [moved] = tabs.splice(from, 1)
      tabs.splice(to, 0, moved)
      return { tabs }
    }),
  activeTab: () => get().tabs.find((t) => t.id === get().activeTabId)
}))
