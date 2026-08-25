import { getTerminalHandle } from './terminalRegistry'
import { formatTerminalLabel } from './pinnedTerminal'
import { usePaneSnapshotStore, type TerminalSnapshot } from '../store/paneSnapshotStore'
import { usePaneDiffStore } from '../store/paneDiffStore'
import { useSessionsStore } from '../store/sessionsStore'
import { t } from './i18n'
import { useLocaleStore } from '../store/localeStore'

function shortTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Freeze a pane's whole scrollback under a timestamped label.
 *
 * Reads the full buffer rather than the viewport: the point of a snapshot is to
 * compare it later against a state you cannot predict, so throwing away
 * scrollback at capture time would be the one loss that cannot be undone.
 */
export function takeSnapshot(terminalId: string): TerminalSnapshot | null {
  const handle = getTerminalHandle(terminalId)
  if (!handle) return null
  const tab = useSessionsStore.getState().sessions.find((tt) => tt.id === terminalId)
  const locale = useLocaleStore.getState().locale
  const name = tab ? formatTerminalLabel(tab) : terminalId
  const label = t(locale, 'snapshot.label', { name, time: shortTime(Date.now()) })
  return usePaneSnapshotStore.getState().take(terminalId, label, handle.readTail(0))
}

/** Snapshot a pane and immediately diff it against that pane's live state. */
export function snapshotAndCompare(terminalId: string): void {
  const snapshot = takeSnapshot(terminalId)
  if (!snapshot) return
  usePaneDiffStore.getState().openSources(
    { kind: 'snapshot', snapshotId: snapshot.id },
    { kind: 'terminal', terminalId }
  )
}
