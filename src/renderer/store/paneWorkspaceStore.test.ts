import { beforeEach, describe, expect, it } from 'vitest'
import { createLeaf } from '../lib/paneLayout'
import { usePaneLayoutStore } from './paneLayoutStore'
import { usePaneWorkspaceStore } from './paneWorkspaceStore'
import { useSessionsStore, type TerminalSession } from './sessionsStore'
import { SAVED_LAYOUT_VERSION, type SavedLayout, type SavedLayoutNode } from '../../shared/types'

const ROOT_PANE = 'pane-root'
const ROOT_TAB = 'wtab-root'

let stored: SavedLayout[] = []

function session(id: string, connectionId?: string): TerminalSession {
  return { id, title: id, status: 'connected', host: 'h', port: 22, username: 'u', connectionId }
}

function twoPanes(a?: string, b?: string): SavedLayoutNode {
  return {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { kind: 'leaf', connectionId: a },
    b: { kind: 'leaf', connectionId: b }
  }
}

function entry(patch: Partial<SavedLayout>): SavedLayout {
  return {
    id: 'saved-1',
    name: 'prod',
    root: twoPanes('conn-a', 'conn-b'),
    createdAt: 0,
    ...patch
  }
}

function tabCount(): number {
  return usePaneLayoutStore.getState().tabs.length
}

beforeEach(() => {
  stored = []
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      config: {
        getLayouts: async () => stored,
        setLayouts: async (list: SavedLayout[]) => {
          stored = list
          return stored
        }
      }
    }
  }

  useSessionsStore.setState({ sessions: [], activeSessionId: null })
  usePaneLayoutStore.setState({
    tabs: [
      { id: ROOT_TAB, root: createLeaf(ROOT_PANE), focusedPaneId: ROOT_PANE, zoomedPaneId: null }
    ],
    activeTabId: ROOT_TAB
  })
  usePaneWorkspaceStore.setState({ layouts: [], loaded: false })
})

describe('save', () => {
  it('stamps the format version onto new entries', async () => {
    useSessionsStore.getState().addSession(session('t1', 'conn-a'))
    usePaneLayoutStore.getState().placeTerminalAuto('t1')

    await usePaneWorkspaceStore.getState().save('prod')

    expect(stored).toHaveLength(1)
    expect(stored[0].version).toBe(SAVED_LAYOUT_VERSION)
    expect(stored[0].root).toEqual({ kind: 'leaf', connectionId: 'conn-a' })
  })

  it('saves only the tab on screen', async () => {
    useSessionsStore.getState().addSession(session('t1', 'conn-a'))
    usePaneLayoutStore.getState().placeTerminalAuto('t1')
    useSessionsStore.getState().addSession(session('t2', 'conn-b'))
    usePaneLayoutStore.getState().newTab('t2')

    await usePaneWorkspaceStore.getState().save('second')

    expect(stored[0].root).toEqual({ kind: 'leaf', connectionId: 'conn-b' })
  })
})

describe('restore', () => {
  it('builds the saved shape as a tab of its own', () => {
    useSessionsStore.getState().addSession(session('t1', 'conn-a'))
    usePaneLayoutStore.getState().placeTerminalAuto('t1')
    usePaneWorkspaceStore.setState({ layouts: [entry({ version: 1 })], loaded: true })

    usePaneWorkspaceStore.getState().restore('saved-1')

    expect(tabCount()).toBe(2)
    expect(usePaneLayoutStore.getState().paneCount()).toBe(2)
  })

  it('reads a v0 entry, which carries no version', () => {
    usePaneWorkspaceStore.setState({ layouts: [entry({})], loaded: true })

    usePaneWorkspaceStore.getState().restore('saved-1')

    expect(usePaneLayoutStore.getState().paneCount()).toBe(2)
  })

  it('refuses an entry written by a newer format', () => {
    usePaneWorkspaceStore.setState({
      layouts: [entry({ version: SAVED_LAYOUT_VERSION + 1 })],
      loaded: true
    })

    usePaneWorkspaceStore.getState().restore('saved-1')

    expect(tabCount()).toBe(1)
    expect(usePaneLayoutStore.getState().paneCount()).toBe(1)
  })
})
