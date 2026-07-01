import { create } from 'zustand'
import type {
  ChartSnapshot,
  CopilotChatMessage,
  CopilotChatState,
  CopilotChatTab,
  ToolCallView
} from '../../shared/types'
import { getCopilotStartupOpen } from './startupStore'

export interface ChatMessage extends CopilotChatMessage {
  streaming?: boolean
  thinkingStartedAt?: number
}

export interface ChatTab extends Omit<CopilotChatTab, 'messages'> {
  messages: ChatMessage[]
}

export const PANEL_MIN_WIDTH = 300
export const PANEL_MAX_WIDTH = 760
const PANEL_DEFAULT_WIDTH = 392
const PANEL_WIDTH_KEY = 'ai.panelWidth'
const PANEL_OPEN_KEY = 'ai.panelOpen'
const MAX_MESSAGES_PER_TAB = 200
const PERSIST_DEBOUNCE_MS = 500
const STREAM_PERSIST_DEBOUNCE_MS = 2000
export const MAX_CHAT_TABS = 5

export const CHAT_HISTORY_7_DAYS_MS = 7 * 24 * 60 * 60 * 1000
export const CHAT_HISTORY_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export const DEFAULT_CHAT_TAB_TITLE = '__copilot_new_chat__'

export const clampPanelWidth = (w: number): number =>
  Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(w)))

function loadPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : PANEL_DEFAULT_WIDTH
}

function loadPanelOpen(): boolean {
  return getCopilotStartupOpen()
}

function savePanelOpen(open: boolean): void {
  localStorage.setItem(PANEL_OPEN_KEY, String(open))
}

export function isOpenTab(tab: ChatTab): boolean {
  return !tab.archived
}

export function openChatTabs(tabs: ChatTab[]): ChatTab[] {
  return tabs.filter(isOpenTab)
}

export function createEmptyChatTab(title = DEFAULT_CHAT_TAB_TITLE): ChatTab {
  return {
    id: crypto.randomUUID(),
    title,
    messages: [],
    draft: '',
    updatedAt: Date.now(),
    archived: false
  }
}

function findTabIndex(tabs: ChatTab[], tabId: string): number {
  return tabs.findIndex((t) => t.id === tabId)
}

function updateTab(tabs: ChatTab[], tabId: string, patch: Partial<ChatTab>): ChatTab[] {
  return tabs.map((t) => (t.id === tabId ? { ...t, ...patch, updatedAt: Date.now() } : t))
}

function isPersistableTab(tab: ChatTab): boolean {
  return tab.messages.length > 0
}

function purgeChatTabs(
  chatTabs: ChatTab[],
  activeChatTabId: string | null,
  shouldRemove: (tab: ChatTab) => boolean
): { chatTabs: ChatTab[]; activeChatTabId: string; removed: number } {
  const removeIds = new Set(chatTabs.filter(shouldRemove).map((t) => t.id))
  if (removeIds.size === 0) {
    return {
      chatTabs,
      activeChatTabId: activeChatTabId ?? chatTabs[0]?.id ?? createEmptyChatTab().id,
      removed: 0
    }
  }

  let remaining = chatTabs.filter((t) => !removeIds.has(t.id))
  const removed = removeIds.size

  if (remaining.length === 0 || openChatTabs(remaining).length === 0) {
    const newTab = createEmptyChatTab()
    remaining = [...remaining, newTab]
    return { chatTabs: remaining, activeChatTabId: newTab.id, removed }
  }

  let nextActive = activeChatTabId
  if (!nextActive || removeIds.has(nextActive)) {
    const open = openChatTabs(remaining)
    nextActive = open[open.length - 1]?.id ?? remaining[0].id
  }

  return { chatTabs: remaining, activeChatTabId: nextActive!, removed }
}

function toPersistedState(
  activeChatTabId: string | null,
  chatTabs: ChatTab[]
): CopilotChatState | null {
  const persistableTabs = chatTabs.filter(isPersistableTab)
  if (persistableTabs.length === 0) return null

  let activeTabId = activeChatTabId
  if (!activeTabId || !persistableTabs.some((t) => t.id === activeTabId)) {
    const open = persistableTabs.filter(isOpenTab)
    const pool = open.length > 0 ? open : persistableTabs
    activeTabId = [...pool].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
  }

  return {
    activeTabId,
    tabs: persistableTabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      draft: tab.draft,
      updatedAt: tab.updatedAt,
      archived: tab.archived ?? false,
      messages: tab.messages.slice(-MAX_MESSAGES_PER_TAB).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        thinkingMs: m.thinkingMs,
        boundSessionId: m.boundSessionId,
        boundTabId: m.boundTabId,
        chartSnapshots: m.chartSnapshots,
        isContextSummary: m.isContextSummary,
        toolCalls: m.toolCalls
      }))
    }))
  }
}

function migratePersistedTabs(chatTabs: ChatTab[]): ChatTab[] {
  const migrated = chatTabs.map((tab) => ({
    ...tab,
    archived: tab.archived ?? false
  }))
  const open = openChatTabs(migrated)
  if (open.length <= MAX_CHAT_TABS) return migrated

  const keepOpen = new Set<string>()
  const byRecency = [...open].sort((a, b) => b.updatedAt - a.updatedAt)
  for (let i = 0; i < MAX_CHAT_TABS && i < byRecency.length; i++) {
    keepOpen.add(byRecency[i].id)
  }
  return migrated.map((tab) =>
    isOpenTab(tab) && !keepOpen.has(tab.id) ? { ...tab, archived: true } : tab
  )
}

function fromPersistedState(state: CopilotChatState): { chatTabs: ChatTab[]; activeChatTabId: string } {
  const chatTabs: ChatTab[] = state.tabs
    .filter((tab) => tab.messages.length > 0)
    .map((tab) => ({
      ...tab,
      archived: tab.archived ?? false,
      messages: tab.messages.map((m) => ({ ...m }))
    }))
  const migrated = migratePersistedTabs(chatTabs)
  let activeChatTabId = state.activeTabId
  if (!migrated.some((t) => t.id === activeChatTabId) && migrated.length > 0) {
    activeChatTabId = migrated[0].id
  }
  const open = openChatTabs(migrated)
  if (open.length === 0) {
    const newTab = createEmptyChatTab()
    return { chatTabs: [...migrated, newTab], activeChatTabId: newTab.id }
  }
  if (!open.some((t) => t.id === activeChatTabId)) {
    activeChatTabId = open[open.length - 1].id
  }
  return { chatTabs: migrated, activeChatTabId }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let streamPersistTimer: ReturnType<typeof setTimeout> | null = null

function schedulePersist(getState: () => AIState): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const { activeChatTabId, chatTabs } = getState()
    void window.api.config.setCopilotChats(toPersistedState(activeChatTabId, chatTabs))
  }, PERSIST_DEBOUNCE_MS)
}

function scheduleStreamPersist(getState: () => AIState): void {
  if (streamPersistTimer) clearTimeout(streamPersistTimer)
  streamPersistTimer = setTimeout(() => {
    streamPersistTimer = null
    schedulePersist(getState)
  }, STREAM_PERSIST_DEBOUNCE_MS)
}

interface AIState {
  panelOpen: boolean
  panelWidth: number
  chatTabs: ChatTab[]
  activeChatTabId: string | null
  busy: boolean
  activeRequestId: string | null
  /** Tab id that owns the in-flight request (for cancel on close). */
  busyTabId: string | null
  notice: string | null
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
  setPanelWidth: (width: number) => void
  setNotice: (notice: string | null) => void
  loadChatState: () => Promise<void>
  persistChatState: () => void
  addChatTab: (title?: string) => string | null
  archiveChatTab: (id: string) => void
  restoreChatTab: (id: string) => boolean
  deleteChatTab: (id: string) => void
  deleteAllChatHistory: () => number
  deleteChatHistoryOlderThan: (maxAgeMs: number) => number
  setActiveChatTab: (id: string) => void
  updateDraft: (tabId: string, draft: string) => void
  clearActiveTab: () => void
  renameTab: (tabId: string, title: string) => void
  addMessage: (tabId: string, msg: ChatMessage) => void
  removeMessage: (tabId: string, id: string) => void
  replaceMessages: (tabId: string, messages: ChatMessage[]) => void
  appendToMessage: (tabId: string, id: string, delta: string) => void
  appendReasoning: (tabId: string, id: string, delta: string) => void
  finishMessage: (tabId: string, id: string) => void
  setToolCalls: (tabId: string, messageId: string, toolCalls: ToolCallView[]) => void
  updateToolCall: (
    tabId: string,
    messageId: string,
    callId: string,
    patch: Partial<ToolCallView>
  ) => void
  setChartSnapshot: (tabId: string, messageId: string, key: string, snapshot: ChartSnapshot) => void
  setBusy: (busy: boolean, requestId?: string | null, tabId?: string | null) => void
  activeChatTab: () => ChatTab | undefined
}

const initialTab = createEmptyChatTab()

export const useAIStore = create<AIState>((set, get) => ({
  panelOpen: loadPanelOpen(),
  panelWidth: loadPanelWidth(),
  chatTabs: [initialTab],
  activeChatTabId: initialTab.id,
  busy: false,
  activeRequestId: null,
  busyTabId: null,
  notice: null,
  togglePanel: () =>
    set((s) => {
      const panelOpen = !s.panelOpen
      savePanelOpen(panelOpen)
      return { panelOpen }
    }),
  setPanelOpen: (open) => {
    savePanelOpen(open)
    set({ panelOpen: open })
  },
  setPanelWidth: (width) => {
    const clamped = clampPanelWidth(width)
    localStorage.setItem(PANEL_WIDTH_KEY, String(clamped))
    set({ panelWidth: clamped })
  },
  setNotice: (notice) => set({ notice }),
  loadChatState: async () => {
    const saved = await window.api.config.getCopilotChats()
    if (!saved || saved.tabs.length === 0) return
    const { chatTabs } = fromPersistedState(saved)
    const archivedTabs = chatTabs.map((tab) =>
      isOpenTab(tab) ? { ...tab, archived: true } : tab
    )
    const newTab = createEmptyChatTab()
    set({ chatTabs: [...archivedTabs, newTab], activeChatTabId: newTab.id })
    schedulePersist(get)
  },
  persistChatState: () => schedulePersist(get),
  addChatTab: (title) => {
    const { chatTabs } = get()
    if (openChatTabs(chatTabs).length >= MAX_CHAT_TABS) return null
    const tab = createEmptyChatTab(title)
    set({
      chatTabs: [...chatTabs, tab],
      activeChatTabId: tab.id
    })
    schedulePersist(get)
    return tab.id
  },
  archiveChatTab: (id) => {
    const tab = get().chatTabs.find((t) => t.id === id)
    if (tab && !tab.archived && tab.messages.length === 0) {
      get().deleteChatTab(id)
      return
    }

    set((s) => {
      const tab = s.chatTabs.find((t) => t.id === id)
      if (!tab || tab.archived) return s

      let chatTabs = updateTab(s.chatTabs, id, { archived: true })
      let activeChatTabId = s.activeChatTabId
      const stillOpen = openChatTabs(chatTabs)

      if (stillOpen.length === 0) {
        const newTab = createEmptyChatTab()
        chatTabs = [...chatTabs, newTab]
        activeChatTabId = newTab.id
      } else if (activeChatTabId === id) {
        activeChatTabId = stillOpen[stillOpen.length - 1].id
      }

      return { chatTabs, activeChatTabId }
    })
    schedulePersist(get)
  },
  restoreChatTab: (id) => {
    const { chatTabs } = get()
    const tab = chatTabs.find((t) => t.id === id)
    if (!tab) return false
    if (!tab.archived) {
      set({ activeChatTabId: id })
      schedulePersist(get)
      return true
    }
    if (openChatTabs(chatTabs).length >= MAX_CHAT_TABS) return false

    set({
      chatTabs: updateTab(chatTabs, id, { archived: false }),
      activeChatTabId: id
    })
    schedulePersist(get)
    return true
  },
  deleteChatTab: (id) => {
    set((s) => {
      const tab = s.chatTabs.find((t) => t.id === id)
      if (!tab) return s

      const chatTabs = s.chatTabs.filter((t) => t.id !== id)
      if (chatTabs.length === 0) {
        const newTab = createEmptyChatTab()
        return { chatTabs: [newTab], activeChatTabId: newTab.id }
      }

      let activeChatTabId = s.activeChatTabId
      if (activeChatTabId === id) {
        const open = openChatTabs(chatTabs)
        activeChatTabId = open[open.length - 1]?.id ?? chatTabs[0].id
      }
      return { chatTabs, activeChatTabId }
    })
    schedulePersist(get)
  },
  deleteAllChatHistory: () => {
    const removed = get().chatTabs.filter(isPersistableTab).length
    if (removed === 0) return 0

    const newTab = createEmptyChatTab()
    set({ chatTabs: [newTab], activeChatTabId: newTab.id })
    schedulePersist(get)
    return removed
  },
  deleteChatHistoryOlderThan: (maxAgeMs) => {
    const cutoff = Date.now() - maxAgeMs
    let removed = 0
    set((s) => {
      const result = purgeChatTabs(
        s.chatTabs,
        s.activeChatTabId,
        (tab) => isPersistableTab(tab) && tab.updatedAt < cutoff
      )
      removed = result.removed
      if (removed === 0) return s
      return { chatTabs: result.chatTabs, activeChatTabId: result.activeChatTabId }
    })
    if (removed > 0) schedulePersist(get)
    return removed
  },
  setActiveChatTab: (id) => {
    set({ activeChatTabId: id })
    schedulePersist(get)
  },
  updateDraft: (tabId, draft) => {
    set((s) => ({ chatTabs: updateTab(s.chatTabs, tabId, { draft }) }))
    schedulePersist(get)
  },
  clearActiveTab: () => {
    const activeId = get().activeChatTabId
    if (!activeId) return
    set((s) => ({
      chatTabs: updateTab(s.chatTabs, activeId, { messages: [], draft: '' })
    }))
    schedulePersist(get)
  },
  renameTab: (tabId, title) => {
    set((s) => ({ chatTabs: updateTab(s.chatTabs, tabId, { title }) }))
    schedulePersist(get)
  },
  addMessage: (tabId, msg) => {
    set((s) => {
      const idx = findTabIndex(s.chatTabs, tabId)
      if (idx < 0) return s
      const tab = s.chatTabs[idx]
      const messages = [...tab.messages, msg].slice(-MAX_MESSAGES_PER_TAB)
      const chatTabs = [...s.chatTabs]
      chatTabs[idx] = { ...tab, messages, updatedAt: Date.now() }
      return { chatTabs }
    })
    schedulePersist(get)
  },
  removeMessage: (tabId, id) => {
    set((s) => ({
      chatTabs: s.chatTabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, updatedAt: Date.now(), messages: tab.messages.filter((m) => m.id !== id) }
          : tab
      )
    }))
    schedulePersist(get)
  },
  replaceMessages: (tabId, messages) => {
    set((s) => ({
      chatTabs: updateTab(s.chatTabs, tabId, {
        messages: messages.slice(-MAX_MESSAGES_PER_TAB)
      })
    }))
    schedulePersist(get)
  },
  appendToMessage: (tabId, id, delta) => {
    set((s) => ({
      chatTabs: s.chatTabs.map((tab) => {
        if (tab.id !== tabId) return tab
        return {
          ...tab,
          updatedAt: Date.now(),
          messages: tab.messages.map((m) => {
            if (m.id !== id) return m
            const thinkingMs =
              m.thinkingMs === undefined && m.thinkingStartedAt !== undefined
                ? Date.now() - m.thinkingStartedAt
                : m.thinkingMs
            return { ...m, content: m.content + delta, thinkingMs }
          })
        }
      })
    }))
    scheduleStreamPersist(get)
  },
  appendReasoning: (tabId, id, delta) => {
    set((s) => ({
      chatTabs: s.chatTabs.map((tab) => {
        if (tab.id !== tabId) return tab
        return {
          ...tab,
          updatedAt: Date.now(),
          messages: tab.messages.map((m) =>
            m.id === id
              ? {
                  ...m,
                  reasoning: (m.reasoning ?? '') + delta,
                  thinkingStartedAt: m.thinkingStartedAt ?? Date.now()
                }
              : m
          )
        }
      })
    }))
    scheduleStreamPersist(get)
  },
  finishMessage: (tabId, id) => {
    set((s) => ({
      chatTabs: s.chatTabs.map((tab) => {
        if (tab.id !== tabId) return tab
        return {
          ...tab,
          updatedAt: Date.now(),
          messages: tab.messages.map((m) => {
            if (m.id !== id) return m
            const thinkingMs =
              m.thinkingMs === undefined && m.thinkingStartedAt !== undefined
                ? Date.now() - m.thinkingStartedAt
                : m.thinkingMs
            return { ...m, streaming: false, thinkingMs }
          })
        }
      })
    }))
    schedulePersist(get)
  },
  setToolCalls: (tabId, messageId, toolCalls) => {
    set((s) => ({
      chatTabs: s.chatTabs.map((tab) => {
        if (tab.id !== tabId) return tab
        return {
          ...tab,
          updatedAt: Date.now(),
          messages: tab.messages.map((m) => (m.id === messageId ? { ...m, toolCalls } : m))
        }
      })
    }))
    schedulePersist(get)
  },
  updateToolCall: (tabId, messageId, callId, patch) => {
    set((s) => ({
      chatTabs: s.chatTabs.map((tab) => {
        if (tab.id !== tabId) return tab
        return {
          ...tab,
          updatedAt: Date.now(),
          messages: tab.messages.map((m) => {
            if (m.id !== messageId || !m.toolCalls) return m
            return {
              ...m,
              toolCalls: m.toolCalls.map((tc) =>
                tc.id === callId ? { ...tc, ...patch } : tc
              )
            }
          })
        }
      })
    }))
    schedulePersist(get)
  },
  setChartSnapshot: (tabId, messageId, key, snapshot) => {
    set((s) => ({
      chatTabs: s.chatTabs.map((tab) => {
        if (tab.id !== tabId) return tab
        return {
          ...tab,
          updatedAt: Date.now(),
          messages: tab.messages.map((m) => {
            if (m.id !== messageId) return m
            const prev = m.chartSnapshots?.[key]
            const merged: ChartSnapshot = {
              spec: snapshot.spec,
              option: snapshot.option ?? prev?.option
            }
            if (prev?.spec === merged.spec && prev?.option === merged.option) return m
            return {
              ...m,
              chartSnapshots: { ...m.chartSnapshots, [key]: merged }
            }
          })
        }
      })
    }))
    schedulePersist(get)
  },
  setBusy: (busy, requestId = null, tabId = null) =>
    set({ busy, activeRequestId: requestId, busyTabId: busy ? tabId : null }),
  activeChatTab: () => {
    const { chatTabs, activeChatTabId } = get()
    return chatTabs.find((t) => t.id === activeChatTabId)
  }
}))
