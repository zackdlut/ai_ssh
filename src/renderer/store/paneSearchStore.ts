import { create } from 'zustand'

export interface SearchFlags {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

interface PaneSearchState {
  /**
   * Terminal whose pane currently shows the search bar, or null when closed.
   *
   * Exactly one search runs at a time, on one terminal. Switching tabs hides it
   * with the pane it belongs to and brings it back on return, since a half-typed
   * query is not something to throw away for looking elsewhere.
   */
  terminalId: string | null
  query: string
  flags: SearchFlags
  resultIndex: number
  resultCount: number
  open: (terminalId: string) => void
  close: () => void
  setQuery: (query: string) => void
  setFlags: (patch: Partial<SearchFlags>) => void
  setResults: (resultIndex: number, resultCount: number) => void
  detachTerminals: (terminalIds: string[]) => void
}

export const usePaneSearchStore = create<PaneSearchState>((set) => ({
  terminalId: null,
  query: '',
  flags: { caseSensitive: false, wholeWord: false, regex: false },
  resultIndex: -1,
  resultCount: 0,

  // The query survives reopening, which is what you want when hunting the same
  // string across several panes.
  open: (terminalId) => set({ terminalId, resultIndex: -1, resultCount: 0 }),
  close: () => set({ terminalId: null, resultIndex: -1, resultCount: 0 }),
  setQuery: (query) => set({ query }),
  setFlags: (patch) => set((s) => ({ flags: { ...s.flags, ...patch } })),
  setResults: (resultIndex, resultCount) => set({ resultIndex, resultCount }),

  detachTerminals: (terminalIds) =>
    set((s) => (s.terminalId && terminalIds.includes(s.terminalId) ? { terminalId: null } : s))
}))
