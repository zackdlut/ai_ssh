import { create } from 'zustand'
import { usePaneLayoutStore } from './paneLayoutStore'
import { useSessionsStore } from './sessionsStore'
import { parseLayout, serializeLayout } from '../lib/paneLayoutSerialize'
import { SAVED_LAYOUT_VERSION, type SavedLayout } from '../../shared/types'

interface PaneWorkspaceState {
  layouts: SavedLayout[]
  loaded: boolean
  load: () => Promise<void>
  /** Store the active tab's tree under `name`, replacing a same-named entry. */
  save: (name: string) => Promise<void>
  /**
   * Rebuild a saved layout as a tab of its own. Never opens connections: dialling
   * four production hosts because a menu item was clicked is not something to do
   * on the user's behalf, so each pane names its host and offers a button.
   */
  restore: (id: string) => void
  remove: (id: string) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
}

function genId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `layout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function paneId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `pane-${crypto.randomUUID()}`
    : `pane-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function persist(layouts: SavedLayout[]): Promise<SavedLayout[]> {
  return window.api.config.setLayouts(layouts)
}

export const usePaneWorkspaceStore = create<PaneWorkspaceState>((set, get) => ({
  layouts: [],
  loaded: false,

  load: async () => {
    const layouts = await window.api.config.getLayouts()
    set({ layouts, loaded: true })
  },

  save: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const { sessions } = useSessionsStore.getState()
    const connectionIdForTerminal = (terminalId: string): string | undefined =>
      sessions.find((session) => session.id === terminalId)?.connectionId
    const root = serializeLayout(
      usePaneLayoutStore.getState().activeTab().root,
      connectionIdForTerminal
    )
    const entry: SavedLayout = {
      id: genId(),
      name: trimmed,
      root,
      createdAt: Date.now(),
      version: SAVED_LAYOUT_VERSION
    }
    const rest = get().layouts.filter((layout) => layout.name !== trimmed)
    const layouts = await persist([...rest, entry])
    set({ layouts })
  },

  restore: (id) => {
    const layout = get().layouts.find((l) => l.id === id)
    if (!layout) return
    // A v0 entry carries no version and needs none: it was already one tree.
    if ((layout.version ?? 0) > SAVED_LAYOUT_VERSION) return
    const root = parseLayout(layout.root, paneId)
    if (!root) return
    usePaneLayoutStore.getState().restoreLayoutInTab(root)
  },

  remove: async (id) => {
    const layouts = await persist(get().layouts.filter((layout) => layout.id !== id))
    set({ layouts })
  },

  rename: async (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const layouts = await persist(
      get().layouts.map((layout) => (layout.id === id ? { ...layout, name: trimmed } : layout))
    )
    set({ layouts })
  }
}))
