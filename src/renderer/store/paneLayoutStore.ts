import { useMemo } from 'react'
import { create } from 'zustand'
import { useSessionsStore } from './sessionsStore'
import {
  clearTerminalsFromLayout,
  collectLeaves,
  computeLayoutBoxes,
  countLeaves,
  createLeaf,
  evenRatios,
  findLeaf,
  findLeafByTerminal,
  MAX_PANES_PER_TAB,
  MAX_PANES_TOTAL,
  nearestPaneInDirection,
  removeLeaf,
  setLeafPending,
  setLeafTerminal,
  setSplitRatio,
  splitLeaf,
  swapLeaves,
  moveLeaf,
  type FocusDirection,
  type PaneLayoutBoxes,
  type PaneNode,
  type SplitDir
} from '../lib/paneLayout'

function genId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const ROOT_PANE_ID = 'pane-root'
const ROOT_TAB_ID = 'wtab-root'

/**
 * One UI tab, owning a whole split tree.
 *
 * This is the Windows Terminal / iTerm model: a tab is a window onto its own
 * pane arrangement, and terminals live in the panes. Focus and zoom belong to
 * the tab rather than the app, so switching tabs restores exactly the pane the
 * user left — the tree is never rebuilt, only shown or hidden.
 */
export interface PaneTab {
  id: string
  /** Set by an explicit rename; otherwise the title comes from the focused pane. */
  customTitle?: string
  root: PaneNode
  focusedPaneId: string
  /** Non-null while one pane is temporarily expanded to the full area. */
  zoomedPaneId: string | null
}

interface PaneLayoutState {
  tabs: PaneTab[]
  activeTabId: string

  /** Open a tab holding a single pane. Returns its id. */
  newTab: (terminalId?: string | null) => string
  /** Drop a tab and its whole tree. The last tab is emptied instead. */
  closeTab: (tabId: string) => void
  activateTab: (tabId: string) => void
  reorderTab: (fromId: string, toId: string) => void
  renameTab: (tabId: string, title: string) => void

  splitFocused: (dir: SplitDir) => void
  splitPane: (paneId: string, dir: SplitDir) => void
  /** Split and fill the new pane in one step, for a terminal dropped on an edge. */
  splitPaneWithTerminal: (
    paneId: string,
    dir: SplitDir,
    terminalId: string,
    before?: boolean
  ) => void
  /** Exchange two panes in the active tab. Focus follows `aId`. */
  swapPanes: (aId: string, bId: string) => void
  /**
   * Relocate a pane beside another in the active tab. Does not add a pane, so
   * the ceilings never apply; `before` matches an edge drop.
   */
  movePane: (sourceId: string, targetId: string, dir: SplitDir, before?: boolean) => void
  closePane: (paneId: string) => void
  focusPane: (paneId: string) => void
  focusDirection: (dir: FocusDirection) => void
  toggleZoom: (paneId?: string) => void
  /** `axisPx` is the split's pixel extent along its axis, for pane minimums. */
  setRatio: (splitId: string, ratio: number, axisPx?: number) => void
  /** Give every pane an equal share of the terminal area. */
  evenOut: () => void
  /** False once a pane ceiling is reached, so callers can disable their UI. */
  canSplit: () => boolean
  /**
   * Bring a terminal into view: focus its pane, switching tabs when it lives in
   * another one. A terminal with no pane anywhere gets a tab of its own.
   */
  showTerminal: (terminalId: string) => void
  /**
   * Show a terminal in one named pane of the active tab. Unlike `showTerminal`
   * this never looks for a better home, because the caller is acting on an
   * explicit drop target.
   */
  showTerminalInPane: (paneId: string, terminalId: string) => void
  /**
   * Give a freshly created terminal a home: an empty pane in the active tab if
   * there is one, otherwise a new tab.
   */
  placeTerminalAuto: (terminalId: string) => void
  /** Forget closed terminals, dropping any tab left with nothing in it. */
  detachTerminals: (terminalIds: string[]) => void
  /** Swap the active tab's tree, used when restoring a saved layout. */
  restoreLayout: (root: PaneNode) => void
  /**
   * Apply a saved shape to a tab of its own, which is what a saved layout is a
   * template for. Returns the tab it landed in.
   */
  restoreLayoutInTab: (root: PaneNode) => string
  /** Clear a pane's pending saved-connection binding. */
  clearPending: (paneId: string) => void
  /** Move focus without touching `activeSessionId`; used while reconciling. */
  focusPaneSilent: (paneId: string) => void

  activeTab: () => PaneTab
  /** The tab whose tree holds a terminal, or null when no tab does. */
  tabIdForTerminal: (terminalId: string) => string | null
  /** The pane holding a terminal, looked up in the active tab only. */
  paneIdForTerminal: (terminalId: string) => string | null
  focusedTerminalId: () => string | null
  /** Panes in the active tab. */
  paneCount: () => number
  /** Panes across every tab, which is what the ceilings are measured against. */
  totalPaneCount: () => number
  /** Terminals with a pane in the active tab, i.e. the ones on screen. */
  visibleTerminalIds: () => string[]
}

function createPaneTab(terminalId: string | null = null, ids?: { tab: string; pane: string }): PaneTab {
  const paneId = ids?.pane ?? genId('pane')
  return {
    id: ids?.tab ?? genId('wtab'),
    root: createLeaf(paneId, terminalId),
    focusedPaneId: paneId,
    zoomedPaneId: null
  }
}

function tabById(tabs: PaneTab[], tabId: string): PaneTab {
  return tabs.find((tab) => tab.id === tabId) ?? tabs[0]
}

/** Replace one tab in the list, leaving the others identity-stable. */
function withTab(tabs: PaneTab[], tabId: string, patch: Partial<PaneTab>): PaneTab[] {
  return tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab))
}

/**
 * A terminal lives in exactly one pane, so putting it somewhere takes it out of
 * wherever it was. `setLeafTerminal` only enforces that inside one tree, which
 * leaves dragging a session from another tab free to duplicate it.
 */
function stripFromOtherTabs(tabs: PaneTab[], keepTabId: string, terminalId: string): PaneTab[] {
  return tabs.map((tab) => {
    if (tab.id === keepTabId) return tab
    const root = clearTerminalsFromLayout(tab.root, [terminalId])
    return root === tab.root ? tab : { ...tab, root }
  })
}

function terminalsIn(tab: PaneTab): string[] {
  return collectLeaves(tab.root)
    .map((leaf) => leaf.terminalId)
    .filter((id): id is string => Boolean(id))
}

/**
 * One pane holding nothing the user has connected — a tab straight off the "+"
 * button, which anything arriving may take over rather than open beside.
 */
function isBlankTab(tab: PaneTab): boolean {
  if (countLeaves(tab.root) > 1) return false
  const [terminalId] = terminalsIn(tab)
  if (!terminalId) return true
  return useSessionsStore.getState().sessions.find((s) => s.id === terminalId)?.status === 'idle'
}

/**
 * Keep `sessionsStore.activeSessionId` equal to whatever the focused pane shows,
 * so the Copilot and SFTP panels keep reading the terminal the user is looking
 * at. Must be called after `set`, never inside an updater — it re-enters the
 * sessions store, which feeds back through `attachPaneBridge`.
 */
function syncActiveSession(tab: PaneTab): void {
  const terminalId = findLeaf(tab.root, tab.focusedPaneId)?.terminalId ?? null
  const sessions = useSessionsStore.getState()
  if (sessions.activeSessionId !== terminalId) sessions.setActive(terminalId)
}

function realPaneId(root: PaneNode, paneId: string, fallback: string): string | null {
  if (findLeaf(root, paneId)) return paneId
  return findLeaf(root, fallback) ? fallback : null
}

export const usePaneLayoutStore = create<PaneLayoutState>((set, get) => ({
  tabs: [createPaneTab(null, { tab: ROOT_TAB_ID, pane: ROOT_PANE_ID })],
  activeTabId: ROOT_TAB_ID,

  activeTab: () => tabById(get().tabs, get().activeTabId),

  newTab: (terminalId = null) => {
    const tab = createPaneTab(terminalId)
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    syncActiveSession(tab)
    return tab.id
  },

  closeTab: (tabId) => {
    const s = get()
    if (!s.tabs.some((tab) => tab.id === tabId)) return
    // The window always shows a tab, so the last one is emptied rather than removed.
    if (s.tabs.length === 1) {
      const fresh = createPaneTab()
      set({ tabs: [fresh], activeTabId: fresh.id })
      syncActiveSession(fresh)
      return
    }
    const index = s.tabs.findIndex((tab) => tab.id === tabId)
    const tabs = s.tabs.filter((tab) => tab.id !== tabId)
    // Falling back to the neighbour on the right matches every tabbed UI.
    const activeTabId =
      s.activeTabId === tabId ? tabs[Math.min(index, tabs.length - 1)].id : s.activeTabId
    set({ tabs, activeTabId })
    syncActiveSession(tabById(tabs, activeTabId))
  },

  activateTab: (tabId) => {
    const s = get()
    if (s.activeTabId === tabId) return
    const tab = s.tabs.find((t) => t.id === tabId)
    if (!tab) return
    set({ activeTabId: tabId })
    syncActiveSession(tab)
  },

  reorderTab: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return s
      const from = s.tabs.findIndex((tab) => tab.id === fromId)
      const to = s.tabs.findIndex((tab) => tab.id === toId)
      if (from < 0 || to < 0) return s
      const tabs = [...s.tabs]
      const [moved] = tabs.splice(from, 1)
      tabs.splice(to, 0, moved)
      return { tabs }
    }),

  renameTab: (tabId, title) =>
    set((s) => {
      const trimmed = title.trim()
      return { tabs: withTab(s.tabs, tabId, { customTitle: trimmed || undefined }) }
    }),

  splitPane: (paneId, dir) => {
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    const target = realPaneId(tab.root, paneId, tab.focusedPaneId)
    if (!target) return
    if (!s.canSplit()) return
    const newPaneId = genId('pane')
    const next: Partial<PaneTab> = {
      root: splitLeaf(tab.root, target, dir, genId('split'), newPaneId),
      focusedPaneId: newPaneId,
      zoomedPaneId: null
    }
    set({ tabs: withTab(s.tabs, tab.id, next) })
    syncActiveSession({ ...tab, ...next })
  },

  splitFocused: (dir) => get().splitPane(get().activeTab().focusedPaneId, dir),

  splitPaneWithTerminal: (paneId, dir, terminalId, before = false) => {
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    const target = realPaneId(tab.root, paneId, tab.focusedPaneId)
    if (!target) return
    // At the ceiling a dropped terminal still has to land somewhere, so show it
    // in the pane that was dropped on rather than dropping the drag on the floor.
    if (!s.canSplit()) {
      get().showTerminalInPane(target, terminalId)
      return
    }
    const newPaneId = genId('pane')
    // Placing the terminal as part of the split (rather than split-then-show)
    // avoids a frame where the new pane renders empty, and avoids
    // `setLeafTerminal` having to evict it from the pane it is dragged out of.
    let root = splitLeaf(tab.root, target, dir, genId('split'), newPaneId, terminalId, before)
    root = setLeafTerminal(root, newPaneId, terminalId)
    const tabs = stripFromOtherTabs(s.tabs, tab.id, terminalId)
    set({ tabs: withTab(tabs, tab.id, { root, focusedPaneId: newPaneId, zoomedPaneId: null }) })
    useSessionsStore.getState().setActive(terminalId)
  },

  swapPanes: (aId, bId) => {
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    const root = swapLeaves(tab.root, aId, bId)
    if (root === tab.root) return
    const patch = { root, focusedPaneId: aId, zoomedPaneId: null }
    set({ tabs: withTab(s.tabs, tab.id, patch) })
    syncActiveSession({ ...tab, ...patch })
  },

  movePane: (sourceId, targetId, dir, before = false) => {
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    const root = moveLeaf(tab.root, sourceId, targetId, dir, genId('split'), before)
    if (root === tab.root) return
    const focusedPaneId = findLeaf(root, sourceId)?.id ?? tab.focusedPaneId
    const patch = { root, focusedPaneId, zoomedPaneId: null }
    set({ tabs: withTab(s.tabs, tab.id, patch) })
    syncActiveSession({ ...tab, ...patch })
  },

  closePane: (paneId) => {
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    const next = removeLeaf(tab.root, paneId)
    if (!next) {
      // Last pane standing: empty it rather than leaving the tab with no pane.
      const patch = { root: setLeafTerminal(tab.root, paneId, null), zoomedPaneId: null }
      set({ tabs: withTab(s.tabs, tab.id, patch) })
      syncActiveSession({ ...tab, ...patch })
      return
    }
    const focusedPaneId = findLeaf(next, tab.focusedPaneId)
      ? tab.focusedPaneId
      : collectLeaves(next)[0].id
    const patch = {
      root: next,
      focusedPaneId,
      zoomedPaneId: tab.zoomedPaneId && findLeaf(next, tab.zoomedPaneId) ? tab.zoomedPaneId : null
    }
    set({ tabs: withTab(s.tabs, tab.id, patch) })
    syncActiveSession({ ...tab, ...patch })
  },

  focusPane: (paneId) => {
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    if (!findLeaf(tab.root, paneId) || tab.focusedPaneId === paneId) return
    const patch = {
      focusedPaneId: paneId,
      // Focusing a pane hidden behind a zoomed one implies leaving zoom.
      zoomedPaneId: tab.zoomedPaneId && tab.zoomedPaneId !== paneId ? null : tab.zoomedPaneId
    }
    set({ tabs: withTab(s.tabs, tab.id, patch) })
    syncActiveSession({ ...tab, ...patch })
  },

  /*
   * Zoom hides the neighbours, but the geometry underneath is still there, so a
   * directional move navigates the real tree and drops out of zoom on arrival —
   * the same thing `focusPane` does, and what tmux does.
   */
  focusDirection: (dir) => {
    const tab = get().activeTab()
    const target = nearestPaneInDirection(
      computeLayoutBoxes(tab.root),
      tab.focusedPaneId,
      dir
    )
    if (target) get().focusPane(target)
  },

  toggleZoom: (paneId) => {
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    const target = paneId ?? tab.focusedPaneId
    if (!findLeaf(tab.root, target)) return
    if (tab.zoomedPaneId === target || countLeaves(tab.root) < 2) {
      set({ tabs: withTab(s.tabs, tab.id, { zoomedPaneId: null }) })
      return
    }
    const patch = { zoomedPaneId: target, focusedPaneId: target }
    set({ tabs: withTab(s.tabs, tab.id, patch) })
    syncActiveSession({ ...tab, ...patch })
  },

  setRatio: (splitId, ratio, axisPx) =>
    set((s) => {
      const tab = tabById(s.tabs, s.activeTabId)
      const root = setSplitRatio(tab.root, splitId, ratio, axisPx)
      return root === tab.root ? s : { tabs: withTab(s.tabs, tab.id, { root }) }
    }),

  evenOut: () =>
    set((s) => {
      const tab = tabById(s.tabs, s.activeTabId)
      const root = evenRatios(tab.root)
      return root === tab.root ? s : { tabs: withTab(s.tabs, tab.id, { root }) }
    }),

  /*
   * Both ceilings are real, and they bound different things.
   *
   * Per tab: every pane on screen owns a live WebGL context, and browsers cap
   * those (commonly 16) then silently drop the oldest, which blanks a terminal
   * that is still connected. Only the active tab's panes render, so this is the
   * limit the GPU actually sees.
   *
   * Overall: every open terminal keeps an xterm buffer and an `ssh:data`
   * subscription alive whether or not its tab is showing, so the total needs a
   * ceiling of its own.
   */
  canSplit: () => {
    const s = get()
    return (
      countLeaves(tabById(s.tabs, s.activeTabId).root) < MAX_PANES_PER_TAB &&
      s.totalPaneCount() < MAX_PANES_TOTAL
    )
  },

  showTerminal: (terminalId) => {
    const s = get()
    const owner = s.tabs.find((tab) => findLeafByTerminal(tab.root, terminalId))
    if (!owner) {
      get().placeTerminalAuto(terminalId)
      return
    }
    const pane = findLeafByTerminal(owner.root, terminalId)!
    const patch = {
      focusedPaneId: pane.id,
      zoomedPaneId: owner.zoomedPaneId && owner.zoomedPaneId !== pane.id ? null : owner.zoomedPaneId
    }
    set({ tabs: withTab(s.tabs, owner.id, patch), activeTabId: owner.id })
    useSessionsStore.getState().setActive(terminalId)
  },

  showTerminalInPane: (paneId, terminalId) => {
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    const target = realPaneId(tab.root, paneId, tab.focusedPaneId)
    if (!target) return
    const patch = {
      root: setLeafTerminal(tab.root, target, terminalId),
      focusedPaneId: target,
      zoomedPaneId: tab.zoomedPaneId && tab.zoomedPaneId !== target ? null : tab.zoomedPaneId
    }
    set({ tabs: withTab(stripFromOtherTabs(s.tabs, tab.id, terminalId), tab.id, patch) })
    useSessionsStore.getState().setActive(terminalId)
  },

  placeTerminalAuto: (terminalId) => {
    const s = get()
    if (s.tabIdForTerminal(terminalId)) return
    const tab = tabById(s.tabs, s.activeTabId)
    const leaves = collectLeaves(tab.root)
    const focused = leaves.find((leaf) => leaf.id === tab.focusedPaneId)
    const empty = focused && !focused.terminalId ? focused : leaves.find((leaf) => !leaf.terminalId)
    if (empty) {
      const patch = {
        root: setLeafTerminal(tab.root, empty.id, terminalId),
        focusedPaneId: empty.id,
        zoomedPaneId: tab.zoomedPaneId && tab.zoomedPaneId !== empty.id ? null : tab.zoomedPaneId
      }
      set({ tabs: withTab(s.tabs, tab.id, patch) })
      useSessionsStore.getState().setActive(terminalId)
      return
    }
    // Every pane in this tab is taken. A tab of its own beats evicting a pane
    // the user arranged, and is what Windows Terminal does for a new session.
    get().newTab(terminalId)
  },

  detachTerminals: (terminalIds) => {
    const s = get()
    if (terminalIds.length === 0) return
    let changed = false
    const emptied = new Set<string>()
    const cleaned = s.tabs.map((tab) => {
      const root = clearTerminalsFromLayout(tab.root, terminalIds)
      if (root === tab.root) return tab
      changed = true
      const next = { ...tab, root }
      if (terminalsIn(next).length === 0) emptied.add(tab.id)
      return next
    })
    if (!changed) return
    /*
     * A tab whose last terminal just closed goes with it, the same way closing a
     * shell closes its tab in Windows Terminal.
     *
     * Only tabs this call emptied qualify. A tab that was already terminal-free
     * is one the user just opened and has not connected yet, and closing a
     * session somewhere else is no reason to take it away.
     */
    let tabs = emptied.size ? cleaned.filter((tab) => !emptied.has(tab.id)) : cleaned
    // Everything closed at once: keep the tab on screen, emptied, because the
    // window always shows one.
    if (tabs.length === 0) tabs = [tabById(cleaned, s.activeTabId)]
    const activeTabId = tabs.some((tab) => tab.id === s.activeTabId)
      ? s.activeTabId
      : tabs[tabs.length - 1].id
    set({ tabs, activeTabId })
  },

  /*
   * Fill a restored shape from the terminals already in this tab, so restoring
   * never unloads one the user still has.
   *
   * Panes are matched to terminals by saved connection first and only then by
   * position: a layout is saved precisely because "prod on the left, dev on the
   * right" matters, and positional filling alone would put them wherever the
   * session order happens to sit.
   */
  restoreLayout: (root) => {
    const leaves = collectLeaves(root)
    if (leaves.length === 0) return
    const s = get()
    const tab = tabById(s.tabs, s.activeTabId)
    const sessions = useSessionsStore.getState().sessions
    const open = terminalsIn(tab)
    const unplaced = new Set(open)

    const assigned = new Map<string, string>()
    for (const leaf of leaves) {
      const wanted = leaf.pendingConnectionId
      if (!wanted) continue
      const match = open.find(
        (id) =>
          unplaced.has(id) && sessions.find((session) => session.id === id)?.connectionId === wanted
      )
      if (match) {
        unplaced.delete(match)
        assigned.set(leaf.id, match)
      }
    }
    // Anything left over falls back to visual order, which is all an unbound
    // pane can be matched on.
    const leftovers = open.filter((id) => unplaced.has(id))
    let cursor = 0
    for (const leaf of leaves) {
      if (assigned.has(leaf.id) || cursor >= leftovers.length) continue
      assigned.set(leaf.id, leftovers[cursor++])
    }

    let next = root
    for (const [paneId, terminalId] of assigned) next = setLeafTerminal(next, paneId, terminalId)

    // Keep the user on the session they were looking at when it survived the
    // restore, rather than snapping to the first pane.
    const activeSessionId = useSessionsStore.getState().activeSessionId
    const nextLeaves = collectLeaves(next)
    const focusedPaneId =
      (activeSessionId
        ? nextLeaves.find((leaf) => leaf.terminalId === activeSessionId)?.id
        : undefined) ??
      nextLeaves.find((leaf) => leaf.terminalId)?.id ??
      nextLeaves[0].id
    const patch = { root: next, focusedPaneId, zoomedPaneId: null }
    set({ tabs: withTab(s.tabs, tab.id, patch) })
    syncActiveSession({ ...tab, ...patch })
  },

  /*
   * A saved layout describes one tab, so restoring one adds a tab instead of
   * rearranging the ones the user already has.
   *
   * The exception is a tab they just opened and have not used: "+ then restore a
   * workspace" means fill this tab, and opening a third one beside an untouched
   * blank would be busywork. Its idle session is then a candidate for the shape's
   * panes, which is why the fill logic in `restoreLayout` still has work to do.
   */
  restoreLayoutInTab: (root) => {
    const s = get()
    if (!isBlankTab(tabById(s.tabs, s.activeTabId))) get().newTab()
    get().restoreLayout(root)
    return get().activeTabId
  },

  clearPending: (paneId) =>
    set((s) => {
      const tab = tabById(s.tabs, s.activeTabId)
      const root = setLeafPending(tab.root, paneId, undefined)
      return root === tab.root ? s : { tabs: withTab(s.tabs, tab.id, { root }) }
    }),

  focusPaneSilent: (paneId) =>
    set((s) => {
      const tab = tabById(s.tabs, s.activeTabId)
      if (tab.focusedPaneId === paneId || !findLeaf(tab.root, paneId)) return s
      return {
        tabs: withTab(s.tabs, tab.id, {
          focusedPaneId: paneId,
          zoomedPaneId: tab.zoomedPaneId && tab.zoomedPaneId !== paneId ? null : tab.zoomedPaneId
        })
      }
    }),

  tabIdForTerminal: (terminalId) =>
    get().tabs.find((tab) => findLeafByTerminal(tab.root, terminalId))?.id ?? null,
  paneIdForTerminal: (terminalId) =>
    findLeafByTerminal(get().activeTab().root, terminalId)?.id ?? null,
  focusedTerminalId: () => {
    const tab = get().activeTab()
    return findLeaf(tab.root, tab.focusedPaneId)?.terminalId ?? null
  },
  paneCount: () => countLeaves(get().activeTab().root),
  totalPaneCount: () => get().tabs.reduce((sum, tab) => sum + countLeaves(tab.root), 0),
  visibleTerminalIds: () => terminalsIn(get().activeTab())
}))

/** Selector: the tab currently on screen. */
export function selectActiveTab(s: PaneLayoutState): PaneTab {
  return tabById(s.tabs, s.activeTabId)
}

/** Subscribe to the tab on screen, so a component re-renders when it changes. */
export function useActivePaneTab(): PaneTab {
  return usePaneLayoutStore(selectActiveTab)
}

/** Resolved pane rects for the active tab, recomputed only on change. */
export function usePaneBoxes(): PaneLayoutBoxes {
  const { root, zoomedPaneId } = useActivePaneTab()
  return useMemo(() => computeLayoutBoxes(root, zoomedPaneId), [root, zoomedPaneId])
}

/**
 * Restore the invariant "`activeSessionId` is the focused pane's terminal".
 *
 * A newly created session with no pane yet (new tab, connect, clone) is placed
 * first — otherwise an already-occupied focused pane would snap `activeSessionId`
 * back and the new session would never appear. After that, the focused pane
 * wins, so incidental session-list updates cannot steal focus.
 */
export function reconcileActiveSession(): void {
  const layout = usePaneLayoutStore.getState()
  const sessions = useSessionsStore.getState()
  const { activeSessionId } = sessions
  if (activeSessionId && !layout.tabIdForTerminal(activeSessionId)) {
    layout.placeTerminalAuto(activeSessionId)
    return
  }
  const focusedTerminalId = layout.focusedTerminalId()
  if (focusedTerminalId) {
    if (activeSessionId !== focusedTerminalId) sessions.setActive(focusedTerminalId)
    return
  }
  if (!activeSessionId) return
  // Focused pane is empty but the active session lives somewhere: follow it,
  // switching tabs when it is not in the one on screen.
  const owner = layout.tabIdForTerminal(activeSessionId)
  if (owner !== layout.activeTabId) {
    layout.showTerminal(activeSessionId)
    return
  }
  const holder = layout.paneIdForTerminal(activeSessionId)
  if (holder) layout.focusPaneSilent(holder)
}
