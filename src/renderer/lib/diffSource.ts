import { getTerminalHandle } from './terminalRegistry'
import { useSessionsStore } from '../store/sessionsStore'
import { formatTerminalLabel } from './pinnedTerminal'

export type DiffRange = 'viewport' | 'recent' | 'all'

export const DIFF_RECENT_LINES = 1000

/** One side of a pane comparison, used by the `diff_panes` tool. */
export type DiffSource = { kind: 'terminal'; terminalId: string }

export function readSource(source: DiffSource | null, range: DiffRange): string {
  if (!source) return ''
  const handle = getTerminalHandle(source.terminalId)
  if (!handle) return ''
  if (range === 'viewport') return handle.readViewport()
  return handle.readTail(range === 'recent' ? DIFF_RECENT_LINES : 0)
}

export function sourceExists(source: DiffSource | null): boolean {
  if (!source) return false
  return useSessionsStore.getState().sessions.some((tab) => tab.id === source.terminalId)
}

export function describeSource(source: DiffSource | null, fallback: string): string {
  if (!source) return fallback
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === source.terminalId)
  return tab ? formatTerminalLabel(tab) : source.terminalId
}
