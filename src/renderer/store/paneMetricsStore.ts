import { create } from 'zustand'

export interface TerminalSize {
  cols: number
  rows: number
}

interface PaneMetricsState {
  /** Terminal grid size per tab id. */
  sizes: Record<string, TerminalSize>
  setSize: (tabId: string, size: TerminalSize) => void
  clear: (tabId: string) => void
}

/**
 * Terminal sizes, pushed from each `TerminalView` resize.
 *
 * Pushed rather than polled: the status bar has to update on the same frame the
 * user finishes dragging a divider, and reading `term.cols` on a timer would
 * either lag behind or burn a render loop.
 */
export const usePaneMetricsStore = create<PaneMetricsState>((set) => ({
  sizes: {},

  setSize: (tabId, size) =>
    set((s) => {
      const current = s.sizes[tabId]
      if (current && current.cols === size.cols && current.rows === size.rows) return s
      return { sizes: { ...s.sizes, [tabId]: size } }
    }),

  clear: (tabId) =>
    set((s) => {
      if (!(tabId in s.sizes)) return s
      const { [tabId]: _drop, ...rest } = s.sizes
      return { sizes: rest }
    })
}))
