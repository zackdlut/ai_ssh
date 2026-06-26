import { create } from 'zustand'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  /** Reasoning/thinking text, streamed separately from the answer body. */
  reasoning?: string
  /** Timestamp (ms) when the first reasoning token arrived. */
  thinkingStartedAt?: number
  /** Total reasoning duration (ms), set once the answer starts or finishes. */
  thinkingMs?: number
  /** SSH session bound via @terminal, so charts can subscribe to its live stream. */
  boundSessionId?: string
  /** Tab id bound via @terminal, used for reading the current buffer snapshot. */
  boundTabId?: string
}

export const PANEL_MIN_WIDTH = 300
export const PANEL_MAX_WIDTH = 760
const PANEL_DEFAULT_WIDTH = 392
const PANEL_WIDTH_KEY = 'ai.panelWidth'

export const clampPanelWidth = (w: number): number =>
  Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(w)))

function loadPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : PANEL_DEFAULT_WIDTH
}

interface AIState {
  panelOpen: boolean
  panelWidth: number
  messages: ChatMessage[]
  busy: boolean
  activeRequestId: string | null
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
  setPanelWidth: (width: number) => void
  addMessage: (msg: ChatMessage) => void
  appendToMessage: (id: string, delta: string) => void
  appendReasoning: (id: string, delta: string) => void
  finishMessage: (id: string) => void
  setBusy: (busy: boolean, requestId?: string | null) => void
  clear: () => void
}

export const useAIStore = create<AIState>((set) => ({
  panelOpen: true,
  panelWidth: loadPanelWidth(),
  messages: [],
  busy: false,
  activeRequestId: null,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelOpen: (open) => set({ panelOpen: open }),
  setPanelWidth: (width) => {
    const clamped = clampPanelWidth(width)
    localStorage.setItem(PANEL_WIDTH_KEY, String(clamped))
    set({ panelWidth: clamped })
  },
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  appendToMessage: (id, delta) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== id) return m
        // First answer token settles the thinking duration (thinking is done).
        const thinkingMs =
          m.thinkingMs === undefined && m.thinkingStartedAt !== undefined
            ? Date.now() - m.thinkingStartedAt
            : m.thinkingMs
        return { ...m, content: m.content + delta, thinkingMs }
      })
    })),
  appendReasoning: (id, delta) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id
          ? {
              ...m,
              reasoning: (m.reasoning ?? '') + delta,
              thinkingStartedAt: m.thinkingStartedAt ?? Date.now()
            }
          : m
      )
    })),
  finishMessage: (id) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== id) return m
        const thinkingMs =
          m.thinkingMs === undefined && m.thinkingStartedAt !== undefined
            ? Date.now() - m.thinkingStartedAt
            : m.thinkingMs
        return { ...m, streaming: false, thinkingMs }
      })
    })),
  setBusy: (busy, requestId = null) => set({ busy, activeRequestId: requestId }),
  clear: () => set({ messages: [] })
}))
