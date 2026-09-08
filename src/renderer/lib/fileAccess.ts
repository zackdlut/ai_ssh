/**
 * One file interface over two transports.
 *
 * The file tools were written when SFTP was the only way to touch a file, so
 * `window.api.sftp.readText` appears verbatim in nine places across the tools,
 * the diff preview, and host memory. A local tab reaches its files through the
 * main process instead, and threading that choice into all nine would have put
 * a `kind === 'local'` branch in every one of them — including the ones, like
 * the diff preview, that have no business knowing what a transport is.
 *
 * So the choice is made once, here. Both back ends already return the same
 * result shapes (`SftpReadTextResult`, `SftpOpResult`), which is what makes a
 * single signature possible rather than a lowest common denominator.
 *
 * Callers must have checked `hasFileChannel` first; a tab without one reaches
 * the `error` return, which exists to be a bug report rather than a fallback.
 */
import type {
  SftpOpResult,
  SftpReadTextResult,
  SftpStatResult
} from '../../shared/types'
import type { TabKind } from '../../shared/tabCapabilities'
import { getTabObservation } from './terminalObservation'

/** The parts of a session these functions need. */
export interface FileTab {
  id: string
  kind?: TabKind
  sessionId?: string
}

/**
 * Where a relative path points on a local tab.
 *
 * SFTP resolves relative paths against the connection's own login directory,
 * so the SSH path never had to answer this. A local read is a bare filesystem
 * call in the main process, whose working directory is wherever the app was
 * launched from and is never what the agent means by `.`.
 */
function localCwd(tab: FileTab): string | undefined {
  return getTabObservation(tab.id)?.cwd
}

function isLocal(tab: FileTab): boolean {
  return tab.kind === 'local'
}

export async function readText(
  tab: FileTab,
  path: string,
  opts?: { startByte?: number; maxBytes?: number }
): Promise<SftpReadTextResult> {
  if (isLocal(tab)) {
    return window.api.local.readText(path, { ...opts, cwd: localCwd(tab) })
  }
  if (!tab.sessionId) return { error: 'Tab has no open session.' }
  return window.api.sftp.readText(tab.sessionId, path, opts)
}

export async function writeText(
  tab: FileTab,
  path: string,
  content: string
): Promise<SftpOpResult> {
  if (isLocal(tab)) {
    return window.api.local.writeText(path, content, localCwd(tab))
  }
  if (!tab.sessionId) return { error: 'Tab has no open session.' }
  return window.api.sftp.writeText(tab.sessionId, path, content)
}

export async function stat(tab: FileTab, path: string): Promise<SftpStatResult> {
  if (isLocal(tab)) return window.api.local.stat(path, localCwd(tab))
  if (!tab.sessionId) return { error: 'Tab has no open session.' }
  return window.api.sftp.stat(tab.sessionId, path)
}

export interface SearchResult {
  /** `path:line:text` records for grep, bare paths for glob. */
  lines: string[]
  /** True when the result cap was reached and matches were left unreported. */
  truncated: boolean
  error?: string
}

/**
 * Guard the search functions, which have no remote implementation.
 *
 * `readText` and `writeText` dispatch; these two cannot, because searching a
 * remote host means running its own `grep`, which lives in `fileTools` beside
 * the shell quoting it needs. Passing an SSH tab here would silently search
 * THIS machine and report the results as the host's — a wrong answer that
 * looks entirely plausible — so it fails loudly instead.
 */
function requireLocal(tab: FileTab): string | null {
  if (isLocal(tab)) return null
  return `Native search is only available on local tabs; tab "${tab.id}" is not one.`
}

/**
 * Search file contents on this machine.
 *
 * The SSH path shells out to `grep -rnIE`, which is both fast and already
 * installed. A local tab can rely on neither: `grep` does not exist on a stock
 * Windows shell, and the quoting a pattern would need to survive PowerShell
 * differs from POSIX in ways that fail silently — a mangled pattern and a
 * genuinely unmatched one both come back empty. So this walks the tree in the
 * main process instead, which also lets it say whether the cap was hit rather
 * than leaving the caller to infer it from a full page of results.
 */
export async function grep(
  tab: FileTab,
  root: string,
  pattern: string,
  opts: { glob?: string; max: number }
): Promise<SearchResult> {
  const wrong = requireLocal(tab)
  if (wrong) return { lines: [], truncated: false, error: wrong }
  const res = await window.api.local.grep(root, pattern, {
    cwd: localCwd(tab),
    glob: opts.glob,
    max: opts.max
  })
  return { lines: res.lines ?? [], truncated: res.truncated ?? false, error: res.error }
}

/** List files matching a name or path glob. See `grep` for why this is native. */
export async function glob(
  tab: FileTab,
  root: string,
  pattern: string,
  opts: { max: number }
): Promise<SearchResult> {
  const wrong = requireLocal(tab)
  if (wrong) return { lines: [], truncated: false, error: wrong }
  const res = await window.api.local.glob(root, pattern, {
    cwd: localCwd(tab),
    max: opts.max
  })
  return { lines: res.lines ?? [], truncated: res.truncated ?? false, error: res.error }
}
