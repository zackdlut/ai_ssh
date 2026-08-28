import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectLeaves, createLeaf } from './paneLayout'
import { attachPaneBridge } from './paneBridge'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'

// `localeStore` reads the cached locale as it is created, so the stub has to be
// in place before the module graph behind `connect` is pulled in.
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {}
}

const { closePaneWithSession, closeSessions } = await import('./connect')

const ROOT_PANE = 'pane-root'
const ROOT_TAB = 'wtab-root'

let closed: string[] = []
let detachBridge: () => void = () => {}

function session(id: string): TerminalSession {
  return {
    id,
    sessionId: `pty-${id}`,
    title: id,
    status: 'connected',
    host: `${id}.example`,
    port: 22,
    username: 'u'
  }
}

function layout() {
  return usePaneLayoutStore.getState()
}

function terminalsOf(tabId: string): (string | null)[] {
  const found = layout().tabs.find((t) => t.id === tabId)!
  return collectLeaves(found.root).map((leaf) => leaf.terminalId)
}

/** Open a session into the focused pane. Hands back its pane id. */
function openInPane(t: TerminalSession): string {
  useSessionsStore.getState().addSession(t)
  layout().showTerminal(t.id)
  return layout().paneIdForTerminal(t.id)!
}

beforeEach(() => {
  closed = []
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { ssh: { close: (sessionId: string) => closed.push(sessionId) } }
  }
  useSessionsStore.setState({ sessions: [], activeSessionId: null })
  usePaneLayoutStore.setState({
    tabs: [
      { id: ROOT_TAB, root: createLeaf(ROOT_PANE), focusedPaneId: ROOT_PANE, zoomedPaneId: null }
    ],
    activeTabId: ROOT_TAB
  })
  // The bridge is what clears closed sessions out of the layout, so the ordering
  // these tests are about only shows up with it attached.
  detachBridge = attachPaneBridge()
})

afterEach(() => detachBridge())

describe('closePaneWithSession', () => {
  it('hangs up the pty and forgets the session', () => {
    const pane = openInPane(session('t1'))

    closePaneWithSession(pane)

    expect(closed).toEqual(['pty-t1'])
    expect(useSessionsStore.getState().sessions).toEqual([])
    // The window always shows a tab, so the last pane is emptied, not removed.
    expect(terminalsOf(ROOT_TAB)).toEqual([null])
  })

  it('leaves the other panes of the split alone', () => {
    openInPane(session('t1'))
    layout().splitFocused('row')
    const pane2 = openInPane(session('t2'))

    closePaneWithSession(pane2)

    expect(closed).toEqual(['pty-t2'])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['t1'])
    expect(terminalsOf(ROOT_TAB)).toEqual(['t1'])
  })

  it('keeps a tab whose remaining pane is empty', () => {
    const pane = openInPane(session('t1'))
    // Split leaves a second, empty pane: the tab holds no other session, but the
    // user still has a pane here and closing this one must not take the tab.
    layout().splitFocused('row')

    closePaneWithSession(pane)

    expect(layout().tabs).toHaveLength(1)
    expect(terminalsOf(ROOT_TAB)).toEqual([null])
    expect(useSessionsStore.getState().sessions).toEqual([])
  })

  it('closes nothing when the pane holds no session', () => {
    openInPane(session('t1'))
    layout().splitFocused('row')
    const empty = layout().activeTab().focusedPaneId

    closePaneWithSession(empty)

    expect(closed).toEqual([])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['t1'])
    expect(terminalsOf(ROOT_TAB)).toEqual(['t1'])
  })
})

describe('closeSessions', () => {
  it('hangs up every pty and detaches them from the layout in one pass', () => {
    openInPane(session('t1'))
    layout().splitFocused('row')
    openInPane(session('t2'))

    closeSessions(['t1', 't2'])

    expect(closed).toEqual(['pty-t1', 'pty-t2'])
    expect(useSessionsStore.getState().sessions).toEqual([])
    expect(layout().tabs).toHaveLength(1)
  })

  it('skips a session that was never dialled', () => {
    useSessionsStore
      .getState()
      .addSession({ id: 'blank', title: 'New tab', status: 'idle', host: '', port: 22, username: '' })

    closeSessions(['blank'])

    expect(closed).toEqual([])
    expect(useSessionsStore.getState().sessions).toEqual([])
  })
})
