import { getTerminalHandle } from './terminalRegistry'
import { getSnapshot } from '../store/paneSnapshotStore'
import { useSessionsStore } from '../store/sessionsStore'
import { formatTerminalLabel } from './pinnedTerminal'

export type DiffRange = 'viewport' | 'recent' | 'all'

export const DIFF_RECENT_LINES = 1000

export interface DiffNormalizeOptions {
  trimTrailing: boolean
  collapseSpaces: boolean
  maskVolatile: boolean
}

/**
 * One side of a comparison. Generalising this beyond a tab id is what lets
 * snapshots reuse the whole diff pipeline: only the read below knows the
 * difference, everything downstream sees plain text.
 */
export type DiffSource =
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'snapshot'; snapshotId: string }

/** Stable identity for equality checks and as a `<select>` option value. */
export function sourceKey(source: DiffSource | null): string {
  if (!source) return ''
  switch (source.kind) {
    case 'terminal':
      return `terminal:${source.terminalId}`
    case 'snapshot':
      return `snap:${source.snapshotId}`
  }
}

export function parseSourceKey(key: string): DiffSource | null {
  if (!key) return null
  const [kind, ...rest] = key.split(':')
  if (kind === 'terminal' && rest[0]) return { kind: 'terminal', terminalId: rest[0] }
  if (kind === 'snap' && rest[0]) return { kind: 'snapshot', snapshotId: rest[0] }
  return null
}

export function sameSource(a: DiffSource | null, b: DiffSource | null): boolean {
  return sourceKey(a) === sourceKey(b) && a !== null
}

/** The tab a source refers to, when it refers to one at all. */
export function sourceTerminalId(source: DiffSource | null): string | null {
  if (!source) return null
  return source.kind === 'snapshot' ? null : source.terminalId
}

/**
 * Read a side as plain text.
 *
 * `range` only applies to live terminals: a snapshot is already a fixed body of
 * text, and re-slicing it to the "current viewport" would be meaningless.
 */
export function readSource(source: DiffSource | null, range: DiffRange): string {
  if (!source) return ''
  switch (source.kind) {
    case 'terminal': {
      const handle = getTerminalHandle(source.terminalId)
      if (!handle) return ''
      if (range === 'viewport') return handle.readViewport()
      return handle.readTail(range === 'recent' ? DIFF_RECENT_LINES : 0)
    }
    case 'snapshot':
      return getSnapshot(source.snapshotId)?.text ?? ''
  }
}

/** Whether a source still resolves to something readable. */
export function sourceExists(source: DiffSource | null): boolean {
  if (!source) return false
  switch (source.kind) {
    case 'terminal':
      return useSessionsStore.getState().sessions.some((tab) => tab.id === source.terminalId)
    case 'snapshot':
      return Boolean(getSnapshot(source.snapshotId))
  }
}

function terminalLabel(terminalId: string): string {
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === terminalId)
  return tab ? formatTerminalLabel(tab) : terminalId
}

/** Human-readable heading for a side. */
export function describeSource(source: DiffSource | null, fallback: string): string {
  if (!source) return fallback
  switch (source.kind) {
    case 'terminal':
      return terminalLabel(source.terminalId)
    case 'snapshot': {
      const snap = getSnapshot(source.snapshotId)
      return snap ? snap.label : fallback
    }
  }
}