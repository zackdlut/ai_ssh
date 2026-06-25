import { create } from 'zustand'
import type { BookmarkFolder, ConnectionConfig } from '../../shared/types'

export type NodeKind = 'folder' | 'connection'

export type TreeNode =
  | { kind: 'folder'; id: string; folder: BookmarkFolder; children: TreeNode[] }
  | { kind: 'connection'; id: string; connection: ConnectionConfig }

interface BookmarksState {
  folders: BookmarkFolder[]
  connections: ConnectionConfig[]
  expanded: Record<string, boolean>
  loaded: boolean

  load: () => Promise<void>
  toggleExpanded: (id: string) => void
  setExpanded: (id: string, value: boolean) => void

  addFolder: (name: string, parentId: string | null) => Promise<void>
  renameFolder: (id: string, name: string) => Promise<void>
  deleteFolder: (id: string) => Promise<void>

  upsertConnection: (conn: ConnectionConfig) => Promise<void>
  deleteConnection: (id: string) => Promise<void>

  /** Move a folder or connection under newParentId, optionally before a sibling. */
  move: (nodeId: string, newParentId: string | null, beforeId?: string | null) => Promise<void>

  getTree: () => TreeNode[]
  /** Saved connections ranked by usage frequency then recency, capped at `limit`. */
  getRecentConnections: (limit?: number) => ConnectionConfig[]
}

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const ord = (v?: number): number => (typeof v === 'number' ? v : Number.MAX_SAFE_INTEGER)

/** Build the nested tree from the flat folders + connections arrays. */
function buildTree(folders: BookmarkFolder[], connections: ConnectionConfig[]): TreeNode[] {
  const childrenOf = (parentId: string | null): TreeNode[] => {
    const nodes: TreeNode[] = []
    for (const f of folders) {
      if ((f.parentId ?? null) === parentId) {
        nodes.push({ kind: 'folder', id: f.id, folder: f, children: childrenOf(f.id) })
      }
    }
    for (const c of connections) {
      if ((c.parentId ?? null) === parentId) {
        nodes.push({ kind: 'connection', id: c.id, connection: c })
      }
    }
    nodes.sort((a, b) => {
      const ao = a.kind === 'folder' ? ord(a.folder.order) : ord(a.connection.order)
      const bo = b.kind === 'folder' ? ord(b.folder.order) : ord(b.connection.order)
      if (ao !== bo) return ao - bo
      const an = a.kind === 'folder' ? a.folder.name : a.connection.name
      const bn = b.kind === 'folder' ? b.folder.name : b.connection.name
      return an.localeCompare(bn)
    })
    return nodes
  }
  return childrenOf(null)
}

/** Ids of folderId and all of its descendant folders. */
function subtreeFolderIds(folders: BookmarkFolder[], folderId: string): Set<string> {
  const ids = new Set<string>()
  const walk = (id: string): void => {
    ids.add(id)
    for (const f of folders) if (f.parentId === id) walk(f.id)
  }
  walk(folderId)
  return ids
}

export const useBookmarksStore = create<BookmarksState>((set, get) => ({
  folders: [],
  connections: [],
  expanded: {},
  loaded: false,

  load: async () => {
    const [connections, folders] = await Promise.all([
      window.api.config.getConnections(),
      window.api.config.getFolders()
    ])
    set({ connections, folders, loaded: true })
  },

  toggleExpanded: (id) =>
    set((s) => ({ expanded: { ...s.expanded, [id]: !(s.expanded[id] ?? true) } })),

  setExpanded: (id, value) => set((s) => ({ expanded: { ...s.expanded, [id]: value } })),

  addFolder: async (name, parentId) => {
    const siblings = get().folders.filter((f) => (f.parentId ?? null) === parentId)
    const conns = get().connections.filter((c) => (c.parentId ?? null) === parentId)
    const maxOrder = Math.max(
      -1,
      ...siblings.map((f) => ord(f.order)).filter((n) => n < Number.MAX_SAFE_INTEGER),
      ...conns.map((c) => ord(c.order)).filter((n) => n < Number.MAX_SAFE_INTEGER)
    )
    const folder: BookmarkFolder = {
      id: genId(),
      name: name.trim() || 'New folder',
      parentId: parentId ?? null,
      order: maxOrder + 1
    }
    const folders = await window.api.config.saveFolder(folder)
    set((s) => ({ folders, expanded: { ...s.expanded, [folder.id]: true } }))
  },

  renameFolder: async (id, name) => {
    const target = get().folders.find((f) => f.id === id)
    if (!target) return
    const folders = await window.api.config.saveFolder({ ...target, name: name.trim() || target.name })
    set({ folders })
  },

  deleteFolder: async (id) => {
    const { folders, connections } = await window.api.config.deleteFolder(id)
    set({ folders, connections })
  },

  upsertConnection: async (conn) => {
    const connections = await window.api.config.saveConnection(conn)
    set({ connections })
  },

  deleteConnection: async (id) => {
    const connections = await window.api.config.deleteConnection(id)
    set({ connections })
  },

  move: async (nodeId, newParentId, beforeId) => {
    const { folders, connections } = get()
    const isFolder = folders.some((f) => f.id === nodeId)

    // Guard: a folder cannot be moved into itself or one of its descendants.
    if (isFolder) {
      const blocked = subtreeFolderIds(folders, nodeId)
      if (newParentId && blocked.has(newParentId)) return
    }

    // Collect current siblings (folders + connections) of the destination,
    // excluding the moved node, in their current visual order.
    const current = buildTree(folders, connections)
    const childrenAt = (parentId: string | null): TreeNode[] => {
      if (parentId === null) return current
      const find = (nodes: TreeNode[]): TreeNode[] | null => {
        for (const n of nodes) {
          if (n.kind === 'folder') {
            if (n.id === parentId) return n.children
            const inner = find(n.children)
            if (inner) return inner
          }
        }
        return null
      }
      return find(current) ?? []
    }

    const dest = childrenAt(newParentId).filter((n) => n.id !== nodeId)
    const ids = dest.map((n) => n.id)
    const insertAt =
      beforeId && ids.includes(beforeId) ? ids.indexOf(beforeId) : ids.length
    ids.splice(insertAt, 0, nodeId)

    const orderMap = new Map<string, number>()
    ids.forEach((id, i) => orderMap.set(id, i))

    const nextFolders = folders.map((f) =>
      orderMap.has(f.id) || f.id === nodeId
        ? {
            ...f,
            parentId: f.id === nodeId ? (newParentId ?? null) : f.parentId,
            order: orderMap.has(f.id) ? (orderMap.get(f.id) as number) : f.order
          }
        : f
    )
    const nextConnections = connections.map((c) =>
      orderMap.has(c.id) || c.id === nodeId
        ? {
            ...c,
            parentId: c.id === nodeId ? (newParentId ?? null) : c.parentId,
            order: orderMap.has(c.id) ? (orderMap.get(c.id) as number) : c.order
          }
        : c
    )

    set({ folders: nextFolders, connections: nextConnections })
    await Promise.all([
      window.api.config.setFolders(nextFolders),
      window.api.config.setConnections(nextConnections)
    ])
  },

  getTree: () => buildTree(get().folders, get().connections),

  getRecentConnections: (limit = 5) => {
    return [...get().connections]
      .sort((a, b) => {
        const ac = a.useCount ?? 0
        const bc = b.useCount ?? 0
        if (ac !== bc) return bc - ac
        const at = a.lastUsedAt ?? 0
        const bt = b.lastUsedAt ?? 0
        if (at !== bt) return bt - at
        return a.name.localeCompare(b.name)
      })
      .slice(0, limit)
  }
}))
