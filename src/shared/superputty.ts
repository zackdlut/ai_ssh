/**
 * Reader and writer for SuperPuTTY's `Sessions.XML`, a flat list of
 * `<SessionData />` elements whose `SessionId` encodes the folder path:
 *
 *   <SessionData SessionId="build_servers/host_a" SessionName="host_a"
 *                Host="10.0.0.1" Port="22" Proto="SSH" Username="me"
 *                ExtraArgs="-pw secret" />
 *
 * Kept free of Electron/Node imports so it can run in either process.
 */

import { folderNamePath, mergeIncoming } from './bookmarkMerge'
import type { BookmarkState, MergeItem, MergeResult } from './bookmarkMerge'
import type { ConnectionConfig } from './types'

/** One `<SessionData />` element, reduced to the fields we can map. */
export interface SuperPuttySession {
  sessionId: string
  name: string
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  /** Folder path segments derived from `SessionId`, outermost first. */
  folderPath: string[]
  /** Protocol as written in the file; only SSH sessions are importable. */
  proto: string
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code)) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Attribute region of a `<SessionData ... />` tag. The inner alternation lets
 * quoted values contain `>`, which XML allows unescaped inside attributes.
 */
const SESSION_TAG_RE = /<SessionData\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gi
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(source)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '')
  }
  return attrs
}

/** Split a PuTTY command line into tokens, honouring quoted values. */
function tokenizeArgs(args: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(args)) !== null) tokens.push(m[1] ?? m[2] ?? m[3])
  return tokens
}

/** Value following `flag` in an `ExtraArgs` string, e.g. `-pw` or `-i`. */
function argValue(args: string, flag: string): string | undefined {
  const tokens = tokenizeArgs(args)
  const idx = tokens.findIndex((token) => token.toLowerCase() === flag)
  if (idx < 0 || idx + 1 >= tokens.length) return undefined
  const value = tokens[idx + 1]
  return value.length > 0 ? value : undefined
}

/**
 * Folder segments for a session. `SessionId` is the folder path joined with
 * the session name, so the name is stripped off rather than assuming the last
 * segment is it — session names may themselves contain a slash.
 */
function folderPathOf(sessionId: string, name: string): string[] {
  const suffix = `/${name}`
  let path: string
  if (name && sessionId.endsWith(suffix)) path = sessionId.slice(0, -suffix.length)
  else path = sessionId.includes('/') ? sessionId.slice(0, sessionId.lastIndexOf('/')) : ''
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

/** Parse the raw XML text into sessions. Throws when the file has none. */
export function parseSessionsXml(xml: string): SuperPuttySession[] {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '')
  const sessions: SuperPuttySession[] = []

  SESSION_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SESSION_TAG_RE.exec(withoutComments)) !== null) {
    const attrs = parseAttrs(m[1])
    const sessionId = (attrs.sessionid ?? '').trim()
    const name = (attrs.sessionname ?? '').trim()
    const host = (attrs.host ?? '').trim()
    const extraArgs = attrs.extraargs ?? ''
    const port = Number.parseInt(attrs.port ?? '', 10)

    sessions.push({
      sessionId,
      name: name || host || sessionId,
      host,
      port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 22,
      username: (attrs.username ?? '').trim(),
      password: argValue(extraArgs, '-pw'),
      privateKey: argValue(extraArgs, '-i'),
      folderPath: folderPathOf(sessionId, name),
      proto: (attrs.proto ?? '').trim()
    })
  }

  if (sessions.length === 0) {
    throw new Error('No <SessionData> entries found — is this a SuperPuTTY Sessions.XML file?')
  }
  return sessions
}

/** Only SSH sessions with a host can become connections. */
function isImportableSession(s: SuperPuttySession): boolean {
  return s.host.length > 0 && (s.proto === '' || s.proto.toLowerCase() === 'ssh')
}

/**
 * Imported connections keep a stable `superputty:<SessionId>` id so that
 * re-importing the same file refreshes entries instead of duplicating them,
 * and so that two labs holding the same host stay separate.
 */
const ID_PREFIX = 'superputty:'

/**
 * Fold sessions into an existing bookmark tree. Entries carrying a protocol we
 * can't speak are counted as skipped rather than dropped silently.
 */
export function mergeSessions(
  sessions: SuperPuttySession[],
  current: BookmarkState,
  newFolderId: () => string
): MergeResult {
  const importable = sessions.filter(isImportableSession)

  const items: MergeItem[] = importable.map((session) => ({
    id: `${ID_PREFIX}${session.sessionId || `${session.username}@${session.host}`}`,
    folderPath: session.folderPath,
    fields: {
      name: session.name,
      host: session.host,
      port: session.port,
      username: session.username,
      ...(session.password ? { password: session.password } : {}),
      ...(session.privateKey ? { privateKey: session.privateKey } : {})
    }
  }))

  const result = mergeIncoming(items, current, newFolderId)
  return { ...result, skipped: result.skipped + (sessions.length - importable.length) }
}

// --- Writing ---

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Quote a PuTTY argument only when it would otherwise split into tokens. */
function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value
}

function extraArgsFor(conn: ConnectionConfig): string {
  const parts: string[] = []
  if (conn.password) parts.push(`-pw ${quoteArg(conn.password)}`)
  if (conn.privateKey) parts.push(`-i ${quoteArg(conn.privateKey)}`)
  return parts.join(' ')
}

const XML_HEADER_LINES = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<ArrayOfSessionData xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
]

/** SuperPuTTY is a Windows app and writes CRLF; match it byte for byte. */
const EOL = '\r\n'

/**
 * Render saved bookmarks as a SuperPuTTY Sessions.XML. Folder nesting is
 * flattened back into the `SessionId` path, and passwords/keys go back into
 * `ExtraArgs`, so the result round-trips through `parseSessionsXml`.
 */
export function buildSessionsXml(current: BookmarkState): { xml: string; exported: number } {
  const { folders, connections } = current
  const usedIds = new Set<string>()

  const rows = connections.map((conn) => {
    const name = conn.name || conn.host
    const path = [...folderNamePath(folders, conn.parentId), name]

    // SessionId is SuperPuTTY's primary key, so disambiguate same-named
    // siblings rather than emitting a file that collapses on re-import.
    let sessionId = path.join('/')
    for (let n = 2; usedIds.has(sessionId); n++) sessionId = `${path.join('/')}_${n}`
    usedIds.add(sessionId)

    return { conn, name, sessionId }
  })

  rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))

  const lines = rows.map(({ conn, name, sessionId }) =>
    [
      '  <SessionData',
      `SessionId="${escapeAttr(sessionId)}"`,
      `SessionName="${escapeAttr(name)}"`,
      'ImageKey="computer"',
      `Host="${escapeAttr(conn.host)}"`,
      `Port="${conn.port}"`,
      'Proto="SSH"',
      'PuttySession="Default Settings"',
      `Username="${escapeAttr(conn.username)}"`,
      `ExtraArgs="${escapeAttr(extraArgsFor(conn))}"`,
      'SPSLFileName=""',
      'RemotePath=""',
      'LocalPath=""',
      '/>'
    ].join(' ')
  )

  return {
    xml: [...XML_HEADER_LINES, ...lines, '</ArrayOfSessionData>'].join(EOL),
    exported: rows.length
  }
}
