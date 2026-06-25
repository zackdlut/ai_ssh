import { create } from 'zustand'
import type { SshStatus } from '../../shared/types'

export interface TerminalTab {
  id: string
  title: string
  sessionId: string
  status: SshStatus
  host: string
  username: string
  message?: string
}

interface TabsState {
  tabs: TerminalTab[]
  activeTabId: string | null
  addTab: (tab: TerminalTab) => void
  removeTab: (id: string) => void
  setActive: (id: string) => void
  setStatusBySession: (sessionId: string, status: SshStatus, message?: string) => void
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
  setActive: (id) => set({ activeTabId: id }),
  setStatusBySession: (sessionId, status, message) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === sessionId ? { ...t, status, message } : t
      )
    })),
  activeTab: () => get().tabs.find((t) => t.id === get().activeTabId)
}))
