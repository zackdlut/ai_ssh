import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectLeaves,
  createLeaf,
  MAX_PANES_PER_TAB,
  MAX_PANES_TOTAL,
  type PaneNode
} from '../lib/paneLayout'
import { reconcileActiveSession, usePaneLayoutStore, type PaneTab } from './paneLayoutStore'
import { useSessionsStore, type TerminalSession } from './sessionsStore'

const ROOT_PANE = 'pane-root'
const ROOT_TAB = 'wtab-root'

function tab(
  id: string,
  status: TerminalSession['status'] = 'idle',
  connectionId?: string
): TerminalSession {
  return { id, title: id, status, host: '', port: 22, username: '', connectionId }
}

/** A saved layout shape as `parseLayout` would hand it over: panes, no sessions. */
function savedShape(connectionIds: (string | undefined)[]): PaneNode {
  const leaf = (index: number): PaneNode => {
    const base = createLeaf(`restored-${index}`)
    const connectionId = connectionIds[index]
    return connectionId ? { ...base, pendingConnectionId: connectionId } : base
  }
  return { kind: 'split', id: 'restored-split', dir: 'row', ratio: 0.5, a: leaf(0), b: leaf(1) }
}

function layout() {
  return usePaneLayoutStore.getState()
}

function activeTab(): PaneTab {
  return layout().activeTab()
}

function terminalsOf(tabId: string): (string | null)[] {
  const found = layout().tabs.find((t) => t.id === tabId)!
  return collectLeaves(found.root).map((leaf) => leaf.terminalId)
}

/** Open a session and give it a home. Hands back its pane id. */
function openInPane(t: TerminalSession): string {
  useSessionsStore.getState().addSession(t)
  layout().showTerminal(t.id)
  return layout().paneIdForTerminal(t.id)!
}

/** Split the focused pane and open a session into the new half. */
function openInNewPane(t: TerminalSession): string {
  layout().splitFocused('row')
  useSessionsStore.getState().addSession(t)
  layout().placeTerminalAuto(t.id)
  return layout().paneIdForTerminal(t.id)!
}

function resetStores(): void {
  useSessionsStore.setState({ sessions: [], activeSessionId: null })
  usePaneLayoutStore.setState({
    tabs: [
      { id: ROOT_TAB, root: createLeaf(ROOT_PANE), focusedPaneId: ROOT_PANE, zoomedPaneId: null }
    ],
    activeTabId: ROOT_TAB
  })
}

describe('per-tab trees', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('splits only the active tab', () => {
    openInPane(tab('t1', 'connected'))
    const second = layout().newTab()
    openInPane(tab('t2', 'connected'))

    layout().splitFocused('row')

    expect(terminalsOf(second)).toEqual(['t2', null])
    expect(terminalsOf(ROOT_TAB)).toEqual(['t1'])
  })

  it('leaves every tree untouched when switching tabs', () => {
    openInPane(tab('t1', 'connected'))
    openInNewPane(tab('t2', 'connected'))
    const second = layout().newTab()
    openInPane(tab('t3', 'connected'))
    const before = layout().tabs

    layout().activateTab(ROOT_TAB)
    layout().activateTab(second)
    layout().activateTab(ROOT_TAB)

    // Identity, not just shape: a re-created tree would remount the terminals.
    expect(layout().tabs).toEqual(before)
    expect(layout().tabs[0]).toBe(before[0])
    expect(layout().tabs[1]).toBe(before[1])
  })

  it('gives each tab its own focus and zoom', () => {
    const firstPane = openInPane(tab('t1', 'connected'))
    layout().splitFocused('row')
    const firstSecondPane = activeTab().focusedPaneId
    layout().toggleZoom(firstSecondPane)

    const second = layout().newTab()
    openInPane(tab('t2', 'connected'))
    expect(activeTab().zoomedPaneId).toBeNull()

    layout().activateTab(ROOT_TAB)
    expect(activeTab().focusedPaneId).toBe(firstSecondPane)
    expect(activeTab().zoomedPaneId).toBe(firstSecondPane)

    layout().focusPane(firstPane)
    expect(activeTab().zoomedPaneId).toBeNull()
    // The other tab never had a zoom to lose.
    expect(layout().tabs.find((t) => t.id === second)!.zoomedPaneId).toBeNull()
  })

  it('closes a pane without touching the other tabs', () => {
    openInPane(tab('t1', 'connected'))
    const second = layout().newTab()
    openInPane(tab('t2', 'connected'))
    const t3Pane = openInNewPane(tab('t3', 'connected'))

    layout().closePane(t3Pane)

    expect(terminalsOf(second)).toEqual(['t2'])
    expect(terminalsOf(ROOT_TAB)).toEqual(['t1'])
  })

  it('activates the owning tab when a terminal in another one is shown', () => {
    openInPane(tab('t1', 'connected'))
    const second = layout().newTab()
    openInPane(tab('t2', 'connected'))

    layout().showTerminal('t1')

    expect(layout().activeTabId).toBe(ROOT_TAB)
    expect(useSessionsStore.getState().activeSessionId).toBe('t1')

    layout().showTerminal('t2')
    expect(layout().activeTabId).toBe(second)
  })

  it('reports pane counts for the active tab and the whole window separately', () => {
    openInPane(tab('t1', 'connected'))
    layout().splitFocused('row')
    layout().newTab()
    openInPane(tab('t2', 'connected'))

    expect(layout().paneCount()).toBe(1)
    expect(layout().totalPaneCount()).toBe(3)
    expect(layout().visibleTerminalIds()).toEqual(['t2'])
  })
})

describe('closeTab', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('drops the tab and falls back to its right-hand neighbour', () => {
    openInPane(tab('t1', 'connected'))
    const second = layout().newTab()
    openInPane(tab('t2', 'connected'))
    const third = layout().newTab()
    openInPane(tab('t3', 'connected'))

    layout().activateTab(second)
    layout().closeTab(second)

    expect(layout().tabs.map((t) => t.id)).toEqual([ROOT_TAB, third])
    expect(layout().activeTabId).toBe(third)
    expect(useSessionsStore.getState().activeSessionId).toBe('t3')
  })

  it('empties the last tab rather than leaving the window with none', () => {
    openInPane(tab('t1', 'connected'))

    layout().closeTab(ROOT_TAB)

    expect(layout().tabs).toHaveLength(1)
    expect(layout().paneCount()).toBe(1)
    expect(layout().visibleTerminalIds()).toEqual([])
    expect(useSessionsStore.getState().activeSessionId).toBeNull()
  })
})

describe('detachTerminals', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('drops a tab whose last terminal closed', () => {
    openInPane(tab('t1', 'connected'))
    const second = layout().newTab()
    openInPane(tab('t2', 'connected'))

    useSessionsStore.getState().removeSession('t2')
    layout().detachTerminals(['t2'])

    expect(layout().tabs.map((t) => t.id)).toEqual([ROOT_TAB])
    expect(layout().activeTabId).toBe(ROOT_TAB)
    expect(second).not.toBe(ROOT_TAB)
  })

  it('keeps a tab that still has another terminal', () => {
    openInPane(tab('t1', 'connected'))
    openInNewPane(tab('t2', 'connected'))

    layout().detachTerminals(['t2'])

    expect(layout().tabs).toHaveLength(1)
    expect(terminalsOf(ROOT_TAB)).toEqual(['t1', null])
  })

  it('keeps one tab when every terminal closes at once', () => {
    openInPane(tab('t1', 'connected'))
    layout().newTab()
    openInPane(tab('t2', 'connected'))

    layout().detachTerminals(['t1', 't2'])

    expect(layout().tabs).toHaveLength(1)
    expect(layout().visibleTerminalIds()).toEqual([])
  })

  it('leaves a freshly opened empty tab alone', () => {
    openInPane(tab('t1', 'connected'))
    const fresh = layout().newTab()

    layout().detachTerminals(['t1'])

    expect(layout().tabs.map((t) => t.id)).toEqual([fresh])
  })
})

describe('reconcileActiveSession', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('gives a new session its own tab when every pane is taken', () => {
    openInPane(tab('t1', 'connected'))

    useSessionsStore.getState().addSession(tab('t2'))
    reconcileActiveSession()

    expect(layout().tabs).toHaveLength(2)
    expect(useSessionsStore.getState().activeSessionId).toBe('t2')
    expect(layout().focusedTerminalId()).toBe('t2')
    // The session that was on screen keeps its pane in the tab it belongs to.
    expect(terminalsOf(ROOT_TAB)).toEqual(['t1'])
    expect(layout().paneIdForTerminal('t1')).toBeNull()
    expect(layout().tabIdForTerminal('t1')).toBe(ROOT_TAB)
  })

  it('prefers an empty pane in the current tab over opening a tab', () => {
    const occupied = openInPane(tab('t1', 'connected'))
    layout().splitFocused('row')
    layout().focusPane(occupied)

    useSessionsStore.getState().addSession(tab('t2'))
    reconcileActiveSession()

    expect(layout().tabs).toHaveLength(1)
    expect(useSessionsStore.getState().activeSessionId).toBe('t2')
    expect(layout().paneIdForTerminal('t1')).toBe(occupied)
    expect(layout().paneIdForTerminal('t2')).not.toBe(occupied)
    expect(layout().focusedTerminalId()).toBe('t2')
  })

  it('does not steal focus when the active session already has a home', () => {
    const pane1 = openInPane(tab('t1', 'connected'))
    openInNewPane(tab('t2', 'connected'))
    layout().focusPane(pane1)

    useSessionsStore.getState().setActive('t2')
    reconcileActiveSession()

    expect(layout().focusedTerminalId()).toBe('t1')
    expect(useSessionsStore.getState().activeSessionId).toBe('t1')
  })

  it('follows the active session into the tab that owns it', () => {
    openInPane(tab('t1', 'connected'))
    const second = layout().newTab()
    openInPane(tab('t2', 'connected'))
    // Empty the focused pane so it cannot answer for the active session.
    layout().closePane(activeTab().focusedPaneId)
    useSessionsStore.getState().setActive('t1')

    reconcileActiveSession()

    expect(layout().activeTabId).toBe(ROOT_TAB)
    expect(layout().focusedTerminalId()).toBe('t1')
    expect(second).not.toBe(ROOT_TAB)
  })
})

describe('splitting limits', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('stops splitting a tab at its pane ceiling', () => {
    openInPane(tab('t1', 'connected'))
    for (let i = 0; i < MAX_PANES_PER_TAB + 4; i++) layout().splitFocused('row')

    expect(layout().paneCount()).toBe(MAX_PANES_PER_TAB)
    expect(layout().canSplit()).toBe(false)
  })

  it('counts panes in every tab against the window ceiling', () => {
    openInPane(tab('t1', 'connected'))
    // Fill the window from separate tabs, so no single tab hits its own ceiling.
    while (layout().totalPaneCount() < MAX_PANES_TOTAL) {
      const before = layout().totalPaneCount()
      if (layout().paneCount() >= MAX_PANES_PER_TAB - 1) layout().newTab()
      layout().splitFocused('row')
      if (layout().totalPaneCount() === before) break
    }

    expect(layout().totalPaneCount()).toBe(MAX_PANES_TOTAL)
    expect(layout().canSplit()).toBe(false)
    // A fresh tab does not buy more room once the window is full.
    layout().newTab()
    expect(layout().canSplit()).toBe(false)
  })

  it('shows a dropped terminal in the target pane rather than losing it', () => {
    const pane = openInPane(tab('t1', 'connected'))
    for (let i = 0; i < MAX_PANES_PER_TAB; i++) layout().splitFocused('row')
    useSessionsStore.getState().addSession(tab('t2', 'connected'))

    layout().splitPaneWithTerminal(pane, 'row', 't2')

    expect(layout().paneCount()).toBe(MAX_PANES_PER_TAB)
    expect(layout().paneIdForTerminal('t2')).toBe(pane)
    expect(useSessionsStore.getState().activeSessionId).toBe('t2')
  })
})

describe('showTerminalInPane', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('honours the named pane even when an empty one is available', () => {
    const occupied = openInPane(tab('t1', 'connected'))
    layout().splitFocused('row')
    const empty = activeTab().focusedPaneId
    useSessionsStore.getState().addSession(tab('t2', 'connected'))

    layout().showTerminalInPane(occupied, 't2')

    expect(layout().paneIdForTerminal('t2')).toBe(occupied)
    expect(activeTab().focusedPaneId).toBe(occupied)
    // The displaced session is only hidden, never closed.
    expect(layout().paneIdForTerminal('t1')).toBeNull()
    expect(useSessionsStore.getState().sessions.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(collectLeaves(activeTab().root).find((l) => l.id === empty)?.terminalId).toBeNull()
  })

  it('moves a terminal out of the pane it came from', () => {
    const first = openInPane(tab('t1', 'connected'))
    layout().splitFocused('row')
    const second = activeTab().focusedPaneId

    layout().showTerminalInPane(second, 't1')

    expect(layout().paneIdForTerminal('t1')).toBe(second)
    expect(collectLeaves(activeTab().root).find((l) => l.id === first)?.terminalId).toBeNull()
  })
})

describe('focusDirection', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('moves across a split and drops out of zoom on arrival', () => {
    const left = openInPane(tab('t1', 'connected'))
    layout().splitFocused('row')
    const right = activeTab().focusedPaneId
    layout().toggleZoom(right)
    expect(activeTab().zoomedPaneId).toBe(right)

    layout().focusDirection('left')

    expect(activeTab().focusedPaneId).toBe(left)
    expect(activeTab().zoomedPaneId).toBeNull()
  })

  it('is a no-op at the edge of the layout', () => {
    const only = openInPane(tab('t1', 'connected'))
    layout().focusDirection('right')
    expect(activeTab().focusedPaneId).toBe(only)
  })

  it('does not cross into another tab', () => {
    openInPane(tab('t1', 'connected'))
    layout().splitFocused('row')
    layout().newTab()
    const only = openInPane(tab('t2', 'connected'))

    layout().focusDirection('left')

    expect(activeTab().focusedPaneId).toBe(only)
  })
})

describe('restoreLayout', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('binds each pane to the session for its saved connection', () => {
    openInPane(tab('dev', 'connected', 'conn-dev'))
    openInNewPane(tab('prod', 'connected', 'conn-prod'))
    // Open order is dev, prod — the saved layout wants the opposite.
    layout().restoreLayout(savedShape(['conn-prod', 'conn-dev']))

    expect(terminalsOf(ROOT_TAB)).toEqual(['prod', 'dev'])
  })

  it('falls back to visual order for panes with no saved connection', () => {
    openInPane(tab('t1', 'connected'))
    openInNewPane(tab('t2', 'connected'))

    layout().restoreLayout(savedShape([undefined, undefined]))

    expect(terminalsOf(ROOT_TAB)).toEqual(['t1', 't2'])
  })

  it('fills around a matched pane without reusing a session twice', () => {
    openInPane(tab('a', 'connected', 'conn-a'))
    openInNewPane(tab('b', 'connected'))

    // Only the second pane names a connection; `b` takes what is left.
    layout().restoreLayout(savedShape([undefined, 'conn-a']))

    expect(terminalsOf(ROOT_TAB)).toEqual(['b', 'a'])
  })

  it('keeps focus on the session the user was looking at', () => {
    openInPane(tab('dev', 'connected', 'conn-dev'))
    openInNewPane(tab('prod', 'connected', 'conn-prod'))
    layout().showTerminal('dev')

    layout().restoreLayout(savedShape(['conn-prod', 'conn-dev']))

    expect(layout().focusedTerminalId()).toBe('dev')
    expect(useSessionsStore.getState().activeSessionId).toBe('dev')
  })

  it('leaves an unmatched pane pending instead of dialling it', () => {
    openInPane(tab('dev', 'connected', 'conn-dev'))

    layout().restoreLayout(savedShape(['conn-dev', 'conn-missing']))

    const leaves = collectLeaves(activeTab().root)
    expect(leaves.map((leaf) => leaf.terminalId)).toEqual(['dev', null])
    expect(leaves[1].pendingConnectionId).toBe('conn-missing')
    // The filled pane no longer advertises a binding it already honoured.
    expect(leaves[0].pendingConnectionId).toBeUndefined()
  })

  it('does not draw sessions out of another tab', () => {
    openInPane(tab('dev', 'connected', 'conn-dev'))
    const second = layout().newTab()
    openInPane(tab('prod', 'connected', 'conn-prod'))

    layout().restoreLayout(savedShape(['conn-dev', 'conn-prod']))

    // Only `prod` lives in this tab, so the pane wanting `conn-dev` stays empty.
    expect(terminalsOf(second)).toEqual([null, 'prod'])
    expect(terminalsOf(ROOT_TAB)).toEqual(['dev'])
  })
})

describe('restoreLayoutInTab', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('adds a tab rather than rearranging the one in use', () => {
    openInPane(tab('dev', 'connected', 'conn-dev'))

    const restored = layout().restoreLayoutInTab(savedShape(['conn-dev', 'conn-prod']))

    expect(restored).not.toBe(ROOT_TAB)
    expect(layout().tabs).toHaveLength(2)
    // The working tab keeps its session; the restored panes wait on their hosts.
    expect(terminalsOf(ROOT_TAB)).toEqual(['dev'])
    expect(terminalsOf(restored)).toEqual([null, null])
  })

  it('takes over a tab the user opened but never connected', () => {
    openInPane(tab('blank', 'idle'))

    const restored = layout().restoreLayoutInTab(savedShape([undefined, undefined]))

    expect(restored).toBe(ROOT_TAB)
    expect(layout().tabs).toHaveLength(1)
    // The idle session has nowhere better to be, so it fills the first pane.
    expect(terminalsOf(ROOT_TAB)).toEqual(['blank', null])
  })

  it('leaves a connected single-pane tab alone', () => {
    openInPane(tab('prod', 'connected', 'conn-prod'))

    const restored = layout().restoreLayoutInTab(savedShape(['conn-prod', undefined]))

    expect(restored).not.toBe(ROOT_TAB)
    expect(terminalsOf(ROOT_TAB)).toEqual(['prod'])
  })

  it('binds the panes of the restored tab to their saved connections', () => {
    const restored = layout().restoreLayoutInTab(savedShape(['conn-a', 'conn-b']))

    const leaves = collectLeaves(layout().tabs.find((t) => t.id === restored)!.root)
    expect(leaves.map((leaf) => leaf.pendingConnectionId)).toEqual(['conn-a', 'conn-b'])
  })
})

describe('swapPanes / movePane', () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it('swaps two panes and focuses the dragged one', () => {
    const left = openInPane(tab('t1', 'connected'))
    const right = openInNewPane(tab('t2', 'connected'))
    layout().focusPane(left)

    layout().swapPanes(left, right)

    expect(layout().paneIdForTerminal('t1')).toBe(left)
    expect(layout().paneIdForTerminal('t2')).toBe(right)
    expect(collectLeaves(activeTab().root).map((leaf) => leaf.id)).toEqual([right, left])
    expect(activeTab().focusedPaneId).toBe(left)
    expect(useSessionsStore.getState().activeSessionId).toBe('t1')
  })

  it('moves a pane beside another without growing the tree', () => {
    const left = openInPane(tab('t1', 'connected'))
    const right = openInNewPane(tab('t2', 'connected'))

    layout().movePane(left, right, 'col')

    expect(layout().paneCount()).toBe(2)
    const root = activeTab().root
    expect(root.kind).toBe('split')
    if (root.kind !== 'split') return
    expect(root.dir).toBe('col')
    expect(collectLeaves(root).map((leaf) => leaf.id)).toEqual([right, left])
    expect(activeTab().focusedPaneId).toBe(left)
  })

  it('clears zoom after a swap', () => {
    const left = openInPane(tab('t1', 'connected'))
    const right = openInNewPane(tab('t2', 'connected'))
    layout().toggleZoom(right)
    expect(activeTab().zoomedPaneId).toBe(right)

    layout().swapPanes(left, right)

    expect(activeTab().zoomedPaneId).toBeNull()
    expect(activeTab().focusedPaneId).toBe(left)
  })
})
