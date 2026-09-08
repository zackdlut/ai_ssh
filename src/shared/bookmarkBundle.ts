import { folderNamePath, mergeIncoming } from './bookmarkMerge'
import type { BookmarkState, MergeItem, MergeResult } from './bookmarkMerge'
import type { BookmarkFolder, ConnectionConfig, SavedSerialOptions } from './types'

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
    if (!isRecord(entry)) {
      dropped++
      continue
    }
    // What makes an entry usable depends on what it is. An SSH entry with no
    // host cannot be dialled, but a serial entry never has one — its address is
    // the port path, so that is what has to be present instead.
    const serial = parseSerial(entry.serial)
    const isSerial = entry.kind === 'serial'
    if (isSerial ? !serial : !str(entry.host)) {
      dropped++
      continue
    }

    const conn: Record<string, unknown> = {
      id: str(entry.id) || defaultId(entry, serial),
      name: str(entry.name) || (isSerial ? (serial?.path ?? 'serial') : str(entry.host)),
      host: str(entry.host),
      port: isSerial ? 0 : toPort(entry.port),
      username: str(entry.username),
      parentId: str(entry.parentId) || null
    }
    if (isSerial) {
      conn.kind = 'serial'
      conn.serial = serial
    }
    optional(conn, 'deviceKind', entry.deviceKind)
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

function defaultId(entry: Record<string, unknown>, serial: SavedSerialOptions | null): string {
  if (serial) return `serial:${serial.path}`
  return `${str(entry.username)}@${str(entry.host)}`
}

/**
 * Read serial port settings from an imported entry.
 *
 * The path is the only field required, because it is the only one that cannot
 * be reconstructed: everything else has a per-board default that
 * `identifySerialDevice` can supply at connect time. Returns null when there is
 * no usable path, which is what marks the entry unimportable.
 */
function parseSerial(raw: unknown): SavedSerialOptions | null {
  if (!isRecord(raw)) return null
  const path = str(raw.path)
  if (!path) return null

  const opts: Record<string, unknown> = { path }
  const baudRate = typeof raw.baudRate === 'number' ? raw.baudRate : Number.NaN
  if (Number.isFinite(baudRate) && baudRate > 0) opts.baudRate = baudRate
  for (const key of ['dataBits', 'stopBits'] as const) {
    if (typeof raw[key] === 'number') opts[key] = raw[key]
  }
  if (typeof raw.parity === 'string') opts.parity = raw.parity
  for (const key of ['rtscts', 'dtr', 'rts', 'echo'] as const) {
    if (typeof raw[key] === 'boolean') opts[key] = raw[key]
  }
  if (typeof raw.newline === 'string') opts.newline = raw.newline
  return opts as unknown as SavedSerialOptions
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
