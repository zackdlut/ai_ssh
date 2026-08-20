import type { BookmarkFolder, ConnectionConfig } from './types'

/**
 * Shared merge core for importing connections from an external file, used by
 * both the SuperPuTTY XML and the native JSON readers. Pure: the caller
 * decides how to persist the result.
 */

/** A connection to fold in, addressed by folder names rather than folder ids. */
export interface MergeItem {
  /** Stable identity; re-importing the same file refreshes this entry. */
  id: string
  /** Folder names from the root down, created on demand. */
  folderPath: string[]
  fields: Omit<ConnectionConfig, 'id' | 'parentId' | 'order'>
}

export interface BookmarkState {
  folders: BookmarkFolder[]
  connections: ConnectionConfig[]
}

export interface MergeResult extends BookmarkState {
  imported: number
  updated: number
  skipped: number
  foldersCreated: number
}

/**
 * Folder names from the root down to `parentId`. Guards against a corrupted
 * tree where a folder chain loops back on itself.
 */
export function folderNamePath(
  folders: BookmarkFolder[],
  parentId: string | null | undefined
): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let id = parentId ?? null
  while (id !== null && !seen.has(id)) {
    seen.add(id)
    const folder = folders.find((f) => f.id === id)
    if (!folder) break
    path.unshift(folder.name)
    id = folder.parentId ?? null
  }
  return path
}

export function mergeIncoming(
  items: MergeItem[],
  current: BookmarkState,
  newFolderId: () => string
): MergeResult {
  const folders = [...current.folders]
  const connections = [...current.connections]

  let imported = 0
  let updated = 0
  let skipped = 0
  let foldersCreated = 0

  /** Next free `order` among a parent's folders and connections. */
  const nextOrder = (parentId: string | null): number => {
    const orders = [
      ...folders.filter((f) => (f.parentId ?? null) === parentId).map((f) => f.order),
      ...connections.filter((c) => (c.parentId ?? null) === parentId).map((c) => c.order)
    ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    return orders.length === 0 ? 0 : Math.max(...orders) + 1
  }

  /** Walk the path, reusing folders that already carry the same name. */
  const ensureFolder = (path: string[]): string | null => {
    let parentId: string | null = null
    for (const name of path) {
      const existing = folders.find(
        (f) => (f.parentId ?? null) === parentId && f.name.toLowerCase() === name.toLowerCase()
      )
      if (existing) {
        parentId = existing.id
        continue
      }
      const folder: BookmarkFolder = {
        id: newFolderId(),
        name,
        parentId,
        order: nextOrder(parentId)
      }
      folders.push(folder)
      foldersCreated++
      parentId = folder.id
    }
    return parentId
  }

  for (const item of items) {
    const parentId = ensureFolder(item.folderPath)

    const existingIdx = connections.findIndex((c) => c.id === item.id)
    if (existingIdx >= 0) {
      // Refresh the fields but keep usage stats and any manual reordering.
      connections[existingIdx] = { ...connections[existingIdx], ...item.fields }
      updated++
      continue
    }

    // Don't shadow a connection the user already created in this same folder.
    const duplicate = connections.some(
      (c) =>
        (c.parentId ?? null) === parentId &&
        c.host === item.fields.host &&
        c.port === item.fields.port &&
        c.username.toLowerCase() === item.fields.username.toLowerCase()
    )
    if (duplicate) {
      skipped++
      continue
    }

    connections.push({ id: item.id, ...item.fields, parentId, order: nextOrder(parentId) })
    imported++
  }

  return { folders, connections, imported, updated, skipped, foldersCreated }
}
