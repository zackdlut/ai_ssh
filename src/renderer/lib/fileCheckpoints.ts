/**
 * File-edit checkpoints: index the `.bak.<timestamp>` copies that file tools
 * already write, so Restore has a list instead of an orphan backup on disk.
 */
import type { FileCheckpoint } from '../../shared/types'

export const MAX_CHECKPOINTS = 30

export function appendCheckpoint(
  existing: readonly FileCheckpoint[] | undefined,
  next: FileCheckpoint,
  max = MAX_CHECKPOINTS
): FileCheckpoint[] {
  return [...(existing ?? []), next].slice(-max)
}

/** True when a backup note is a real remote path, not a skip/failure. */
export function isRegisteredBackupNote(note: string | undefined): boolean {
  return !!note && /^backup:\s+\S/.test(note)
}

export function parseBackupPath(result: string | undefined): string | undefined {
  if (!result) return undefined
  const match = /^backup:\s+(.+)$/m.exec(result)
  const path = match?.[1]?.trim()
  if (!path || path.startsWith('skipped') || path.startsWith('failed')) return undefined
  return path
}

export function checkpointFromBackupNote(
  path: string,
  note: string,
  terminalTabId: string
): Omit<FileCheckpoint, 'id' | 'at'> | null {
  if (!isRegisteredBackupNote(note)) return null
  const backupPath = parseBackupPath(note)
  if (!backupPath) return null
  return { terminalTabId, path, backupPath }
}

export function shortCheckpointPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}

export function matchCheckpoint(
  checkpoints: readonly FileCheckpoint[] | undefined,
  opts: { path?: string; backupPath?: string }
): FileCheckpoint | undefined {
  if (!checkpoints || checkpoints.length === 0) return undefined
  if (opts.backupPath) {
    const byBak = [...checkpoints].reverse().find((c) => c.backupPath === opts.backupPath)
    if (byBak) return byBak
  }
  if (opts.path) {
    return [...checkpoints].reverse().find((c) => c.path === opts.path)
  }
  return undefined
}
