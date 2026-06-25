import { create } from 'zustand'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

interface AIState {
  panelOpen: boolean
  messages: ChatMessage[]
  busy: boolean
  activeRequestId: string | null
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
  addMessage: (msg: ChatMessage) => void
  appendToMessage: (id: string, delta: string) => void
  finishMessage: (id: string) => void
  setBusy: (busy: boolean, requestId?: string | null) => void
  clear: () => void
}

export const useAIStore = create<AIState>((set) => ({
  panelOpen: true,
  messages: [],
  busy: false,
  activeRequestId: null,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelOpen: (open) => set({ panelOpen: open }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  appendToMessage: (id, delta) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + delta } : m
      )
    })),
  finishMessage: (id) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, streaming: false } : m))
    })),
  setBusy: (busy, requestId = null) => set({ busy, activeRequestId: requestId }),
  clear: () => set({ messages: [] })
}))
