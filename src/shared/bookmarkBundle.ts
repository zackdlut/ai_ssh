import { folderNamePath, mergeIncoming } from './bookmarkMerge'
import type { BookmarkState, MergeItem, MergeResult } from './bookmarkMerge'
import type { BookmarkFolder, ConnectionConfig } from './types'

/**
 * Native JSON transfer format. Unlike the SuperPuTTY XML this is lossless: it
 * carries the passphrase, usage stats and ordering that the PuTTY schema has
 * nowhere to put, so it is the format to use for backups.
 */

export const BUNDLE_FORMAT = 'ai-terminal-connections'
export const BUNDLE_VERSION = 1

export interface ConnectionBundle {
  format: typeof BUNDLE_FORMAT
  version: number
  exportedAt: string
  folders: BookmarkFolder[]
  connections: ConnectionConfig[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function toPort(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseInt(str(v), 10)
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 22
}

/** Copy an optional string field only when it carries something. */
function optional(target: Record<string, unknown>, key: string, value: unknown): void {
  const s = str(value)
  if (s) target[key] = s
}

export interface ParsedBundle extends BookmarkState {
  /** Entries that were structurally unusable, e.g. missing a host. */
  dropped: number
}

/** Parse and validate bundle text. Throws when the file isn't one of ours. */
export function parseConnectionBundle(text: string): ParsedBundle {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!isRecord(raw) || !Array.isArray(raw.connections)) {
    throw new Error('Missing a "connections" array — is this a connections export?')
  }
  if (raw.format !== undefined && raw.format !== BUNDLE_FORMAT) {
    throw new Error(`Unsupported format "${String(raw.format)}"`)
  }

  const folders: BookmarkFolder[] = (Array.isArray(raw.folders) ? raw.folders : [])
    .filter(isRecord)
    .filter((f) => str(f.id) && str(f.name))
    .map((f, i) => ({
      id: str(f.id),
      name: str(f.name),
      parentId: str(f.parentId) || null,
      order: typeof f.order === 'number' && Number.isFinite(f.order) ? f.order : i
    }))

  let dropped = 0
  const connections: ConnectionConfig[] = []
  for (const entry of raw.connections) {
    if (!isRecord(entry) || !str(entry.host)) {
      dropped++
      continue
    }
    const conn: Record<string, unknown> = {
      id: str(entry.id) || `${str(entry.username)}@${str(entry.host)}`,
      name: str(entry.name) || str(entry.host),
      host: str(entry.host),
      port: toPort(entry.port),
      username: str(entry.username),
      parentId: str(entry.parentId) || null
    }
    optional(conn, 'password', entry.password)
    optional(conn, 'privateKey', entry.privateKey)
    optional(conn, 'passphrase', entry.passphrase)
    if (typeof entry.order === 'number') conn.order = entry.order
    if (typeof entry.useCount === 'number') conn.useCount = entry.useCount
    if (typeof entry.lastUsedAt === 'number') conn.lastUsedAt = entry.lastUsedAt
    connections.push(conn as unknown as ConnectionConfig)
  }

  return { folders, connections, dropped }
}

/**
 * Fold a parsed bundle into the existing tree. Folders are matched by name so
 * importing into a store that already has `build_servers` reuses it rather
 * than creating a second one under a different id.
 */
export function mergeBundle(
  bundle: ParsedBundle,
  current: BookmarkState,
  newFolderId: () => string
): MergeResult {
  const items: MergeItem[] = bundle.connections.map((conn) => {
    const { id, parentId, order, ...fields } = conn
    void parentId
    void order
    return { id, folderPath: folderNamePath(bundle.folders, conn.parentId), fields }
  })

  const result = mergeIncoming(items, current, newFolderId)
  return { ...result, skipped: result.skipped + bundle.dropped }
}

/** Serialize the saved bookmarks as pretty-printed JSON. */
export function buildConnectionBundle(current: BookmarkState): {
  json: string
  exported: number
} {
  const bundle: ConnectionBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    folders: current.folders,
    connections: current.connections
  }
  return { json: `${JSON.stringify(bundle, null, 2)}\n`, exported: current.connections.length }
}
