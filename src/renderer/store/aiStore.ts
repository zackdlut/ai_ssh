import { create } from 'zustand'
import type { CopilotChatMessage, CopilotChatState, CopilotChatTab } from '../../shared/types'

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
const MAX_MESSAGES_PER_TAB = 200
const PERSIST_DEBOUNCE_MS = 500
export const MAX_CHAT_TABS = 5

export const DEFAULT_CHAT_TAB_TITLE = '__copilot_new_chat__'

export const clampPanelWidth = (w: number): number =>
  Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(w)))

function loadPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : PANEL_DEFAULT_WIDTH
}

export function createEmptyChatTab(title = DEFAULT_CHAT_TAB_TITLE): ChatTab {
  return {
    id: crypto.randomUUID(),
    title,
    messages: [],
    draft: '',
    updatedAt: Date.now()
  }
}

function findTabIndex(tabs: ChatTab[], tabId: string): number {
  return tabs.findIndex((t) => t.id === tabId)
}

function updateTab(tabs: ChatTab[], tabId: string, patch: Partial<ChatTab>): ChatTab[] {
  return tabs.map((t) => (t.id === tabId ? { ...t, ...patch, updatedAt: Date.now() } : t))
}

function toPersistedState(
  activeChatTabId: string | null,
  chatTabs: ChatTab[]
): CopilotChatState | null {
  if (!activeChatTabId || chatTabs.length === 0) return null
  return {
    activeTabId: activeChatTabId,
    tabs: chatTabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      draft: tab.draft,
      updatedAt: tab.updatedAt,
      messages: tab.messages.slice(-MAX_MESSAGES_PER_TAB).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        thinkingMs: m.thinkingMs,
        boundSessionId: m.boundSessionId,
        boundTabId: m.boundTabId
      }))
    }))
  }
}

function fromPersistedState(state: CopilotChatState): { chatTabs: ChatTab[]; activeChatTabId: string } {
  const chatTabs: ChatTab[] = state.tabs.map((tab) => ({
    ...tab,
    messages: tab.messages.map((m) => ({ ...m }))
  }))
  let activeChatTabId = state.activeTabId
  if (!chatTabs.some((t) => t.id === activeChatTabId) && chatTabs.length > 0) {
    activeChatTabId = chatTabs[0].id
  }
  return trimChatTabs(chatTabs, activeChatTabId)
}

function trimChatTabs(
  chatTabs: ChatTab[],
  activeChatTabId: string
): { chatTabs: ChatTab[]; activeChatTabId: string } {
  if (chatTabs.length <= MAX_CHAT_TABS) {
    return { chatTabs, activeChatTabId }
  }
  const keep = new Set<string>()
  const active = chatTabs.find((t) => t.id === activeChatTabId)
  if (active) keep.add(active.id)
  const byRecency = [...chatTabs].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const tab of byRecency) {
    if (keep.size >= MAX_CHAT_TABS) break
    keep.add(tab.id)
  }
  const trimmed = chatTabs.filter((t) => keep.has(t.id))
  const nextActive = keep.has(activeChatTabId) ? activeChatTabId : (trimmed[0]?.id ?? activeChatTabId)
  return { chatTabs: trimmed, activeChatTabId: nextActive }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

function schedulePersist(getState: () => AIState): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const { activeChatTabId, chatTabs } = getState()
    void window.api.config.setCopilotChats(toPersistedState(activeChatTabId, chatTabs))
  }, PERSIST_DEBOUNCE_MS)
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
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
  setPanelWidth: (width: number) => void
  loadChatState: () => Promise<void>
  persistChatState: () => void
  addChatTab: (title?: string) => string | null
  removeChatTab: (id: string) => void
  setActiveChatTab: (id: string) => void
  updateDraft: (tabId: string, draft: string) => void
  clearActiveTab: () => void
  renameTab: (tabId: string, title: string) => void
  addMessage: (tabId: string, msg: ChatMessage) => void
  appendToMessage: (tabId: string, id: string, delta: string) => void
  appendReasoning: (tabId: string, id: string, delta: string) => void
  finishMessage: (tabId: string, id: string) => void
  setBusy: (busy: boolean, requestId?: string | null, tabId?: string | null) => void
  activeChatTab: () => ChatTab | undefined
}

const initialTab = createEmptyChatTab()

export const useAIStore = create<AIState>((set, get) => ({
  panelOpen: true,
  panelWidth: loadPanelWidth(),
  chatTabs: [initialTab],
  activeChatTabId: initialTab.id,
  busy: false,
  activeRequestId: null,
  busyTabId: null,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelOpen: (open) => set({ panelOpen: open }),
  setPanelWidth: (width) => {
    const clamped = clampPanelWidth(width)
    localStorage.setItem(PANEL_WIDTH_KEY, String(clamped))
    set({ panelWidth: clamped })
  },
  loadChatState: async () => {
    const saved = await window.api.config.getCopilotChats()
    if (!saved || saved.tabs.length === 0) return
    const { chatTabs, activeChatTabId } = fromPersistedState(saved)
    set({ chatTabs, activeChatTabId })
    if (saved.tabs.length > MAX_CHAT_TABS) schedulePersist(get)
  },
  persistChatState: () => schedulePersist(get),
  addChatTab: (title) => {
    const { chatTabs } = get()
    if (chatTabs.length >= MAX_CHAT_TABS) return null
    const tab = createEmptyChatTab(title)
    set({
      chatTabs: [...chatTabs, tab],
      activeChatTabId: tab.id
    })
    schedulePersist(get)
    return tab.id
  },
  removeChatTab: (id) => {
    set((s) => {
      if (s.chatTabs.length <= 1) {
        const reset = createEmptyChatTab()
        return { chatTabs: [reset], activeChatTabId: reset.id }
      }
      const chatTabs = s.chatTabs.filter((t) => t.id !== id)
      let activeChatTabId = s.activeChatTabId
      if (activeChatTabId === id) {
        activeChatTabId = chatTabs[chatTabs.length - 1]?.id ?? null
      }
      return { chatTabs, activeChatTabId }
    })
    schedulePersist(get)
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
  appendToMessage: (tabId, id, delta) =>
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
    })),
  appendReasoning: (tabId, id, delta) =>
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
    })),
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
  setBusy: (busy, requestId = null, tabId = null) =>
    set({ busy, activeRequestId: requestId, busyTabId: busy ? tabId : null }),
  activeChatTab: () => {
    const { chatTabs, activeChatTabId } = get()
    return chatTabs.find((t) => t.id === activeChatTabId)
  }
}))
