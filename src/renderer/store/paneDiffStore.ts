import { create } from 'zustand'
import { usePaneLayoutStore } from './paneLayoutStore'
import { usePaneSyncStore } from './paneSyncStore'
import {
  sameSource,
  sourceExists,
  type DiffNormalizeOptions,
  type DiffRange,
  type DiffSource
} from '../lib/diffSource'

export {
  DIFF_RECENT_LINES,
  type DiffNormalizeOptions,
  type DiffRange,
  type DiffSource
} from '../lib/diffSource'

interface PaneDiffState {
  open: boolean
  left: DiffSource | null
  right: DiffSource | null
  range: DiffRange
  normalize: DiffNormalizeOptions
  onlyChanges: boolean
  /** Bumped to force a fresh read of both sides. */
  reloadToken: number
  openPanel: (leftTerminalId?: string | null) => void
  /** Open showing two arbitrary sources, used by snapshots. */
  openSources: (left: DiffSource | null, right: DiffSource | null) => void
  close: () => void
  setSide: (side: 'left' | 'right', source: DiffSource | null) => void
  swap: () => void
  setRange: (range: DiffRange) => void
  setNormalize: (patch: Partial<DiffNormalizeOptions>) => void
  setOnlyChanges: (on: boolean) => void
  reload: () => void
  detachTerminals: (terminalIds: string[]) => void
  /** Drop sides whose snapshot no longer exists. */
  pruneMissing: () => void
}

/**
 * Pick the other side of the comparison: a locked peer first (the user already
 * grouped those panes), otherwise any other terminal in the tab on screen.
 */
function pickCounterpart(leftTerminalId: string | null): DiffSource | null {
  const visible = usePaneLayoutStore.getState().visibleTerminalIds()
  const candidates = visible.filter((id) => id !== leftTerminalId)
  if (candidates.length === 0) return null
  const { lockedTerminalIds } = usePaneSyncStore.getState()
  const terminalId = candidates.find((id) => lockedTerminalIds.includes(id)) ?? candidates[0]
  return { kind: 'terminal', terminalId }
}

export const usePaneDiffStore = create<PaneDiffState>((set, get) => ({
  open: false,
  left: null,
  right: null,
  range: 'recent',
  normalize: { trimTrailing: true, collapseSpaces: false, maskVolatile: true },
  onlyChanges: false,
  reloadToken: 0,

  openPanel: (leftTerminalId) => {
    const layout = usePaneLayoutStore.getState()
    const terminalId = leftTerminalId ?? layout.focusedTerminalId() ?? layout.visibleTerminalIds()[0] ?? null
    const left: DiffSource | null = terminalId ? { kind: 'terminal', terminalId } : null
    const current = get()
    // Keep an explicit earlier pick when it is still valid and not the new left.
    const right =
      current.right && !sameSource(current.right, left) && sourceExists(current.right)
        ? current.right
        : pickCounterpart(terminalId)
    set({ open: true, left, right, reloadToken: current.reloadToken + 1 })
  },

  openSources: (left, right) =>
    set((s) => ({ open: true, left, right, reloadToken: s.reloadToken + 1 })),

  close: () => set({ open: false }),

  setSide: (side, source) =>
    set((s) => {
      const other = side === 'left' ? s.right : s.left
      // Selecting what is already on the other side swaps rather than dupes.
      const collides = sameSource(source, other)
      const patch =
        side === 'left'
          ? { left: source, right: collides ? s.left : s.right }
          : { right: source, left: collides ? s.right : s.left }
      return { ...patch, reloadToken: s.reloadToken + 1 }
    }),

  swap: () =>
    set((s) => ({ left: s.right, right: s.left, reloadToken: s.reloadToken + 1 })),

  setRange: (range) => set((s) => ({ range, reloadToken: s.reloadToken + 1 })),
  setNormalize: (patch) => set((s) => ({ normalize: { ...s.normalize, ...patch } })),
  setOnlyChanges: (on) => set({ onlyChanges: on }),
  reload: () => set((s) => ({ reloadToken: s.reloadToken + 1 })),

  detachTerminals: (terminalIds) =>
    set((s) => {
      const drop = new Set(terminalIds)
      // A snapshot outlives its tab, so only live-tab sides are detached.
      const stale = (source: DiffSource | null): boolean =>
        source?.kind === 'terminal' && drop.has(source.terminalId)
      const left = stale(s.left) ? null : s.left
      const right = stale(s.right) ? null : s.right
      if (left === s.left && right === s.right) return s
      return { left, right }
    }),

  pruneMissing: () =>
    set((s) => {
      const left = s.left && !sourceExists(s.left) ? null : s.left
      const right = s.right && !sourceExists(s.right) ? null : s.right
      if (left === s.left && right === s.right) return s
      return { left, right }
    })
}))
