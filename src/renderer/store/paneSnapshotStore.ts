import { create } from 'zustand'

export interface TerminalSnapshot {
  id: string
  /** Session the text was taken from, kept for labelling only. */
  terminalId: string
  label: string
  text: string
  at: number
}

/**
 * Snapshots hold a whole scrollback each, which can run to megabytes, so they
 * live in memory for the session rather than in electron-store, and the oldest
 * is dropped once the cap is reached.
 */
export const MAX_SNAPSHOTS = 20

interface PaneSnapshotState {
  snapshots: TerminalSnapshot[]
  take: (terminalId: string, label: string, text: string) => TerminalSnapshot | null
  remove: (id: string) => void
}

function genId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const usePaneSnapshotStore = create<PaneSnapshotState>((set) => ({
  snapshots: [],

  take: (terminalId, label, text) => {
    if (!text.trim()) return null
    const snapshot: TerminalSnapshot = { id: genId(), terminalId, label, text, at: Date.now() }
    set((s) => ({ snapshots: [snapshot, ...s.snapshots].slice(0, MAX_SNAPSHOTS) }))
    return snapshot
  },

  remove: (id) => set((s) => ({ snapshots: s.snapshots.filter((snap) => snap.id !== id) }))
}))

export function getSnapshot(id: string): TerminalSnapshot | undefined {
  return usePaneSnapshotStore.getState().snapshots.find((snap) => snap.id === id)
}
