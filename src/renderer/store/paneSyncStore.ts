import { create } from 'zustand'
import { getTerminalHandle } from '../lib/terminalRegistry'

/** Below two locked panes there is nothing to synchronise. */
export const MIN_SYNC_GROUP = 2

interface PaneSyncState {
  /**
   * Terminals in the sync group, in lock order. Locking is what makes panes scroll
   * together — there is no separate scroll switch, since a lock group that does
   * not scroll together has no other purpose.
   */
  lockedTerminalIds: string[]
  syncInput: boolean
  /**
   * Top visible line each locked pane sat on when the group was aligned, keyed
   * by terminal id. Scroll sync moves every pane the same number of lines away from
   * its own anchor, so panes holding different amounts of output stay on the
   * content the user lined them up on.
   */
  scrollAnchors: Record<string, number>
  /** Terminals that ignore all keyboard input, including broadcasts. */
  readOnlyTerminalIds: string[]
  toggleLock: (terminalId: string) => void
  clearLocks: () => void
  /** Re-anchor the group on what each locked pane is showing right now. */
  realignScroll: () => void
  /** Arm/disarm broadcasting. Arming needs a real group to broadcast to. */
  setSyncInput: (on: boolean) => void
  toggleReadOnly: (terminalId: string) => void
  detachTerminals: (terminalIds: string[]) => void
}

/** Where each pane is parked right now, as the baseline for relative scrolling. */
function readAnchors(terminalIds: string[]): Record<string, number> {
  const anchors: Record<string, number> = {}
  for (const terminalId of terminalIds) {
    const top = getTerminalHandle(terminalId)?.getViewportTop()
    if (top !== undefined) anchors[terminalId] = top
  }
  return anchors
}

export const usePaneSyncStore = create<PaneSyncState>((set) => ({
  lockedTerminalIds: [],
  syncInput: false,
  scrollAnchors: {},
  readOnlyTerminalIds: [],

  toggleLock: (terminalId) =>
    set((s) => {
      const locked = s.lockedTerminalIds.includes(terminalId)
      const lockedTerminalIds = locked
        ? s.lockedTerminalIds.filter((id) => id !== terminalId)
        : [...s.lockedTerminalIds, terminalId]
      // Dropping below a real group silently disarms broadcasting.
      const usable = lockedTerminalIds.length >= MIN_SYNC_GROUP
      return {
        lockedTerminalIds,
        // Whatever the panes show as the group changes shape is the baseline.
        scrollAnchors: readAnchors(lockedTerminalIds),
        syncInput: usable && s.syncInput
      }
    }),

  clearLocks: () => set({ lockedTerminalIds: [], scrollAnchors: {}, syncInput: false }),

  realignScroll: () => set((s) => ({ scrollAnchors: readAnchors(s.lockedTerminalIds) })),

  setSyncInput: (on) =>
    // Refuse to arm without a group: a switch that reads "on" while nothing is
    // listening is worse than one that does not move.
    set((s) => ({ syncInput: on && s.lockedTerminalIds.length >= MIN_SYNC_GROUP })),

  toggleReadOnly: (terminalId) =>
    set((s) => ({
      readOnlyTerminalIds: s.readOnlyTerminalIds.includes(terminalId)
        ? s.readOnlyTerminalIds.filter((id) => id !== terminalId)
        : [...s.readOnlyTerminalIds, terminalId]
    })),

  detachTerminals: (terminalIds) =>
    set((s) => {
      const drop = new Set(terminalIds)
      const lockedTerminalIds = s.lockedTerminalIds.filter((id) => !drop.has(id))
      const readOnlyTerminalIds = s.readOnlyTerminalIds.filter((id) => !drop.has(id))
      if (
        lockedTerminalIds.length === s.lockedTerminalIds.length &&
        readOnlyTerminalIds.length === s.readOnlyTerminalIds.length
      ) {
        return s
      }
      const usable = lockedTerminalIds.length >= MIN_SYNC_GROUP
      return {
        lockedTerminalIds,
        readOnlyTerminalIds,
        // Keep the survivors on their existing baseline rather than re-reading
        // it, so a pane closing elsewhere does not shift the alignment.
        scrollAnchors: Object.fromEntries(
          Object.entries(s.scrollAnchors).filter(([id]) => !drop.has(id))
        ),
        syncInput: usable && s.syncInput
      }
    })
}))

export function isTerminalLocked(terminalId: string): boolean {
  return usePaneSyncStore.getState().lockedTerminalIds.includes(terminalId)
}

/** Selector: the group is big enough to sync, so scrolling is mirrored. */
export function selectGroupActive(s: { lockedTerminalIds: string[] }): boolean {
  return s.lockedTerminalIds.length >= MIN_SYNC_GROUP
}

export function isTerminalReadOnly(terminalId: string): boolean {
  return usePaneSyncStore.getState().readOnlyTerminalIds.includes(terminalId)
}

/** Locked tabs other than `terminalId`, i.e. the broadcast/scroll targets. */
export function lockedPeers(terminalId: string): string[] {
  const { lockedTerminalIds } = usePaneSyncStore.getState()
  if (!lockedTerminalIds.includes(terminalId) || lockedTerminalIds.length < MIN_SYNC_GROUP) return []
  return lockedTerminalIds.filter((id) => id !== terminalId)
}
