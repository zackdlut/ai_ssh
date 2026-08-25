/**
 * Registry that lets non-terminal components (e.g. the AI panel, tab bar, the
 * pane sync group) interact with a terminal tab without holding a direct
 * reference to the xterm instance.
 */
export interface TerminalSearchOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  /** Expand the current selection when it still matches, used while typing. */
  incremental?: boolean
}

export interface TerminalSearchResults {
  /** Index of the active match, or -1 when there is none. */
  resultIndex: number
  resultCount: number
}

export interface TerminalSearch {
  findNext: (query: string, options?: TerminalSearchOptions) => boolean
  findPrevious: (query: string, options?: TerminalSearchOptions) => boolean
  /** Drop highlights and the search selection. */
  clear: () => void
  /** Subscribe to match counts. Returns an unsubscribe function. */
  onResults: (listener: (results: TerminalSearchResults) => void) => () => void
}

export interface TerminalHandle {
  /** Serialize the buffer; a negative `maxLines` means the whole scrollback. */
  readOutput: (maxLines?: number) => string
  /**
   * The rows on screen right now, verbatim. Unlike `readOutput` this keeps blank
   * runs and honours the scroll position, which a diff needs — collapsing blank
   * lines would shift every line number on one side only.
   */
  readViewport: () => string
  /** The last `maxLines` rows verbatim; a non-positive count means all of them. */
  readTail: (maxLines: number) => string
  toggleNl: () => void
  isNlMode: () => boolean
  /** Absolute buffer index of the top visible row. */
  getViewportTop: () => number
  /** Scroll so `line` (an absolute buffer index) is the top visible row. */
  scrollToAbsolute: (line: number) => void
  /** Current terminal grid size, as xterm has fitted it to the pane. */
  getSize: () => { cols: number; rows: number }
  /** In-pane find. No-ops when the search addon could not be loaded. */
  search: TerminalSearch
}

const handles = new Map<string, TerminalHandle>()

export function registerTerminal(tabId: string, handle: TerminalHandle): void {
  handles.set(tabId, handle)
}

export function unregisterTerminal(tabId: string): void {
  handles.delete(tabId)
}

export function getTerminalHandle(tabId: string): TerminalHandle | undefined {
  return handles.get(tabId)
}

export function toggleNlForTab(tabId: string): void {
  handles.get(tabId)?.toggleNl()
}

export function isTabInNlMode(tabId: string): boolean {
  return handles.get(tabId)?.isNlMode() ?? false
}

export const COPILOT_CONTEXT_MAX_LINES = 100
/** Sliding window when the user mentions @terminal in Copilot chat. */
export const COPILOT_TERMINAL_MENTION_MAX_LINES = 200

export function readTerminalOutput(
  tabId: string | null | undefined,
  maxLines = COPILOT_CONTEXT_MAX_LINES
): string {
  if (!tabId) return ''
  return handles.get(tabId)?.readOutput(maxLines) ?? ''
}

export function readFullTerminalOutput(tabId: string): string {
  return readTerminalOutput(tabId, -1)
}
