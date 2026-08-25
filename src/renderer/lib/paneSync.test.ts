import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLeaf } from './paneLayout'
import { usePaneLayoutStore } from '../store/paneLayoutStore'
import { usePaneSyncStore } from '../store/paneSyncStore'
import { useSessionsStore, type TerminalSession } from '../store/sessionsStore'

interface FakeHandle {
  isNlMode: () => boolean
  getViewportTop: () => number
  scrollToAbsolute: (line: number) => void
}

const handles = new Map<string, FakeHandle>()

vi.mock('./terminalRegistry', () => ({
  getTerminalHandle: (id: string) => handles.get(id)
}))

vi.mock('./execCapture', () => ({
  isSessionCaptureActive: () => false
}))

const { broadcastInput, broadcastScroll } = await import('./paneSync')

const writes: { sessionId: string; data: string }[] = []
const scrolls: { terminalId: string; line: number }[] = []

function session(id: string): TerminalSession {
  return {
    id,
    sessionId: `pty-${id}`,
    title: id,
    status: 'connected',
    host: 'h',
    port: 22,
    username: 'u'
  }
}

function fakeHandle(id: string, viewportTop: number): FakeHandle {
  return {
    isNlMode: () => false,
    getViewportTop: () => viewportTop,
    scrollToAbsolute: (line) => scrolls.push({ terminalId: id, line })
  }
}

/** Two panes (t1 | t2) in tab A, one pane (t3) in tab B, all three locked. */
let tabA: string
let tabB: string

beforeEach(() => {
  writes.length = 0
  scrolls.length = 0
  handles.clear()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      ssh: {
        write: (sessionId: string, data: string) => writes.push({ sessionId, data })
      }
    }
  }

  tabA = 'wtab-a'
  useSessionsStore.setState({ sessions: [], activeSessionId: null })
  usePaneLayoutStore.setState({
    tabs: [{ id: tabA, root: createLeaf('pane-a'), focusedPaneId: 'pane-a', zoomedPaneId: null }],
    activeTabId: tabA
  })
  usePaneSyncStore.setState({
    lockedTerminalIds: [],
    readOnlyTerminalIds: [],
    scrollAnchors: {},
    syncInput: false
  })

  for (const id of ['t1', 't2', 't3']) {
    handles.set(id, fakeHandle(id, 100))
    useSessionsStore.getState().addSession(session(id))
  }

  const layout = usePaneLayoutStore.getState()
  layout.placeTerminalAuto('t1')
  layout.splitFocused('row')
  layout.placeTerminalAuto('t2')
  tabB = layout.newTab('t3')
  layout.activateTab(tabA)

  const sync = usePaneSyncStore.getState()
  sync.toggleLock('t1')
  sync.toggleLock('t2')
  sync.toggleLock('t3')
  sync.setSyncInput(true)
})

describe('broadcastInput', () => {
  it('reaches locked peers in the tab on screen', () => {
    const result = broadcastInput('t1', 'ls\r')

    expect(result.delivered).toEqual(['t2'])
    expect(writes).toEqual([{ sessionId: 'pty-t2', data: 'ls\r' }])
  })

  it('never writes to a locked pane in another tab', () => {
    broadcastInput('t1', 'rm -rf /\r')

    expect(writes.map((w) => w.sessionId)).not.toContain('pty-t3')
  })

  it('goes nowhere when the source itself is off screen', () => {
    usePaneLayoutStore.getState().activateTab(tabB)

    const result = broadcastInput('t1', 'ls\r')

    expect(result.delivered).toEqual([])
    expect(writes).toEqual([])
  })

  it('follows the group into whichever tab is on screen', () => {
    usePaneLayoutStore.getState().activateTab(tabB)

    // t3 is alone in tab B, so its locked peers are all elsewhere.
    expect(broadcastInput('t3', 'ls\r').delivered).toEqual([])

    usePaneLayoutStore.getState().activateTab(tabA)

    expect(broadcastInput('t2', 'ls\r').delivered).toEqual(['t1'])
  })
})

describe('broadcastScroll', () => {
  it('moves locked peers in the tab on screen', () => {
    handles.set('t1', fakeHandle('t1', 140))

    broadcastScroll('t1')

    expect(scrolls).toEqual([{ terminalId: 't2', line: 140 }])
  })

  it('leaves panes in other tabs where they are', () => {
    handles.set('t1', fakeHandle('t1', 140))

    broadcastScroll('t1')

    expect(scrolls.map((s) => s.terminalId)).not.toContain('t3')
  })

  it('ignores output-driven scrolling in a background tab', () => {
    usePaneLayoutStore.getState().activateTab(tabB)
    handles.set('t1', fakeHandle('t1', 140))

    broadcastScroll('t1')

    expect(scrolls).toEqual([])
  })
})
