import { join } from 'path'

/** Legal in POSIX names but rejected by Windows filesystems. */
const UNSAFE_CHARS = /[<>:"|?*\\\u0000-\u001f]/g

function safeSegment(segment: string): string {
  const cleaned = segment.replace(UNSAFE_CHARS, '_').replace(/[. ]+$/, '')
  return cleaned || '_'
}

/**
 * Map a remote file to the local path of the temp copy that gets handed to the
 * OS default application.
 *
 * The remote directory layout is mirrored under `baseDir` so that opening
 * `/etc/nginx/conf` and `/etc/apache/conf` does not make one silently
 * overwrite the other, and so the copy keeps its original name — the extension
 * is what decides which application the OS launches. `.` and `..` segments are
 * dropped rather than resolved, so a hostile remote path cannot escape
 * `baseDir`.
 */
export function remoteTempPath(baseDir: string, sessionId: string, remotePath: string): string {
  const segments = remotePath
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map(safeSegment)
  if (segments.length === 0) throw new Error(`Cannot open remote path: ${remotePath}`)
  return join(baseDir, safeSegment(sessionId), ...segments)
}
