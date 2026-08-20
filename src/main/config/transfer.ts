import { getConnections, getFolders, setConnections, setFolders } from './store'
import {
  buildConnectionBundle,
  mergeBundle,
  parseConnectionBundle
} from '../../shared/bookmarkBundle'
import { buildSessionsXml, mergeSessions, parseSessionsXml } from '../../shared/superputty'
import type { MergeResult } from '../../shared/bookmarkMerge'
import type { BookmarkTransferFormat, ImportSessionsResult } from '../../shared/types'

function genFolderId(): string {
  return `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Parse a connections file and merge it into the saved bookmarks. */
export function importBookmarks(
  format: BookmarkTransferFormat,
  text: string
): ImportSessionsResult {
  const current = { folders: getFolders(), connections: getConnections() }

  const result: MergeResult =
    format === 'json'
      ? mergeBundle(parseConnectionBundle(text), current, genFolderId)
      : mergeSessions(parseSessionsXml(text), current, genFolderId)

  const { folders, connections, imported, updated, skipped, foldersCreated } = result
  setFolders(folders)
  setConnections(connections)

  return { imported, updated, skipped, foldersCreated, folders, connections }
}

/** Render the saved bookmarks in the requested format. */
export function exportBookmarks(format: BookmarkTransferFormat): {
  text: string
  exported: number
} {
  const current = { folders: getFolders(), connections: getConnections() }
  if (format === 'json') {
    const { json, exported } = buildConnectionBundle(current)
    return { text: json, exported }
  }
  const { xml, exported } = buildSessionsXml(current)
  return { text: xml, exported }
}
