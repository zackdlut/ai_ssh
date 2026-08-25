import { useActivePaneTab } from '../store/paneLayoutStore'
import { usePaneMetricsStore } from '../store/paneMetricsStore'
import { usePaneSyncStore } from '../store/paneSyncStore'
import { useSessionsStore } from '../store/sessionsStore'
import { countLeaves, findLeaf } from '../lib/paneLayout'
import { formatTerminalLabel } from '../lib/pinnedTerminal'
import { useT } from '../lib/i18n'
import SyncGroupStatus from './pane/SyncGroupStatus'

/**
 * One-line summary of the focused pane and the split state.
 *
 * Sits below `.terminal-area` rather than inside it, because the pane rects are
 * percentages of that element: putting a fixed-height bar inside would make
 * every pane's geometry depend on it.
 */
export default function StatusBar(): JSX.Element {
  const t = useT()
  const { root, focusedPaneId, zoomedPaneId } = useActivePaneTab()
  const sessions = useSessionsStore((s) => s.sessions)
  const sizes = usePaneMetricsStore((s) => s.sizes)
  const readOnlyTerminalIds = usePaneSyncStore((s) => s.readOnlyTerminalIds)

  const zoomed = Boolean(zoomedPaneId)
  const terminalId = findLeaf(root, focusedPaneId)?.terminalId ?? null
  const session = terminalId ? sessions.find((s) => s.id === terminalId) : undefined
  const size = terminalId ? sizes[terminalId] : undefined
  const paneCount = countLeaves(root)

  return (
    <div className="status-bar" role="status">
      <span className="status-bar-name" title={session ? formatTerminalLabel(session) : undefined}>
        {session ? formatTerminalLabel(session) : t('pane.emptyTitle')}
      </span>
      {size && (
        <span className="status-bar-item status-bar-size">
          {t('status.size', { cols: size.cols, rows: size.rows })}
        </span>
      )}
      {paneCount > 1 && (
        <span className="status-bar-item">{t('status.panes', { count: paneCount })}</span>
      )}
      {zoomed && <span className="status-bar-item">{t('status.zoomed')}</span>}
      {terminalId && readOnlyTerminalIds.includes(terminalId) && (
        <span className="status-bar-item status-bar-item--warn">{t('pane.readOnly')}</span>
      )}
      <span className="status-bar-spacer" />
      <SyncGroupStatus />
    </div>
  )
}
