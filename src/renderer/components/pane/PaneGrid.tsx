import { useRef, useState } from 'react'
import { paneRectStyle, type PaneDivider, type PaneLayoutBoxes, type PaneRect } from '../../lib/paneLayout'
import {
  isLayoutDrag,
  PANE_DRAG_MIME,
  paneDropAction,
  type PaneDropZone
} from '../../lib/tabDrag'
import { selectActiveTab, usePaneLayoutStore } from '../../store/paneLayoutStore'
import { useTabDragStore } from '../../store/tabDragStore'
import { MIN_SYNC_GROUP, usePaneSyncStore } from '../../store/paneSyncStore'
import { usePaneSearchStore } from '../../store/paneSearchStore'
import { useSessionsStore, type TerminalSession } from '../../store/sessionsStore'
import { useBookmarksStore } from '../../store/bookmarksStore'
import { connectFromConfig } from '../../lib/connect'
import { useT } from '../../lib/i18n'
import UiIcon from '../UiIcon'
import TerminalEmptyState from '../TerminalEmptyState'
import PaneSearchBar from './PaneSearchBar'

interface Props {
  boxes: PaneLayoutBoxes
  onNewConnection: () => void
}

/**
 * Chrome for the split grid: pane borders, headers and drag handles. The xterm
 * hosts are positioned separately by `App` so they never move in the DOM, which
 * means everything here has to stay click-through except its own controls.
 */
export default function PaneGrid({ boxes, onNewConnection }: Props): JSX.Element {
  const split = boxes.leaves.length > 1

  return (
    <>
      {boxes.leaves.map(({ leaf, rect }, i) => (
        <PaneFrame
          key={leaf.id}
          paneId={leaf.id}
          terminalId={leaf.terminalId}
          groupIndex={split ? i + 1 : null}
          pendingConnectionId={leaf.pendingConnectionId}
          rect={rect}
          showHeader={split}
          onNewConnection={onNewConnection}
        />
      ))}
      {boxes.dividers.map((divider) => (
        <PaneDividerHandle key={divider.splitId} divider={divider} />
      ))}
    </>
  )
}

interface FrameProps {
  paneId: string
  terminalId: string | null
  groupIndex: number | null
  pendingConnectionId?: string
  rect: PaneRect
  showHeader: boolean
  onNewConnection: () => void
}

function sessionLabel(session: TerminalSession): string {
  return session.customTitle ?? session.title
}

function PaneFrame({
  paneId,
  terminalId,
  groupIndex,
  pendingConnectionId,
  rect,
  showHeader,
  onNewConnection
}: FrameProps): JSX.Element {
  const t = useT()
  const session = useSessionsStore((s) =>
    terminalId ? s.sessions.find((x) => x.id === terminalId) : undefined
  )
  const focused = usePaneLayoutStore((s) => selectActiveTab(s).focusedPaneId === paneId)
  const zoomed = usePaneLayoutStore((s) => selectActiveTab(s).zoomedPaneId === paneId)
  const focusPane = usePaneLayoutStore((s) => s.focusPane)
  const closePane = usePaneLayoutStore((s) => s.closePane)
  const splitPane = usePaneLayoutStore((s) => s.splitPane)
  const toggleZoom = usePaneLayoutStore((s) => s.toggleZoom)
  const locked = usePaneSyncStore((s) => Boolean(terminalId) && s.lockedTerminalIds.includes(terminalId!))
  const readOnly = usePaneSyncStore((s) => Boolean(terminalId) && s.readOnlyTerminalIds.includes(terminalId!))
  const broadcasting = usePaneSyncStore(
    (s) => s.syncInput && s.lockedTerminalIds.length >= MIN_SYNC_GROUP
  )
  const toggleLock = usePaneSyncStore((s) => s.toggleLock)
  const toggleReadOnly = usePaneSyncStore((s) => s.toggleReadOnly)
  const searching = usePaneSearchStore((s) => Boolean(terminalId) && s.terminalId === terminalId)
  const canSplit = usePaneLayoutStore((s) => s.canSplit())
  const dragging = useTabDragStore((s) => s.sourcePaneId === paneId)

  const focus = (): void => focusPane(paneId)
  const armed = locked && broadcasting
  const splitTitle = (label: string): string => (canSplit ? label : t('pane.maxPanes'))

  const classes = [
    'pane-frame',
    focused ? 'is-focused' : '',
    locked ? 'is-locked' : '',
    armed ? 'is-broadcast' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} style={paneRectStyle(rect)}>
      <div className="pane-frame-border" aria-hidden />
      {showHeader && (
        <div
          className={`pane-header ${dragging ? 'is-dragging' : ''}`}
          draggable
          title={t('pane.dragHint')}
          onMouseDown={focus}
          onDragStart={(e) => {
            // Pressing a header button must not start a drag instead of acting.
            if ((e.target as HTMLElement).closest('button')) {
              e.preventDefault()
              return
            }
            e.dataTransfer.effectAllowed = 'move'
            // `attachTabDragTracking` arms the drop zones off this payload.
            e.dataTransfer.setData(PANE_DRAG_MIME, paneId)
          }}
        >
          <span className={`status-dot ${session ? (session.nlMode ? 'nl' : session.status) : 'idle'}`} />
          {groupIndex ? <span className="pane-header-index">{groupIndex}</span> : null}
          <span className="pane-header-title" title={session ? sessionLabel(session) : t('pane.emptyTitle')}>
            {session ? sessionLabel(session) : t('pane.emptyTitle')}
          </span>
          {armed && <span className="pane-header-badge">{t('sync.input')}</span>}
          <span className="pane-header-spacer" />
          <button
            type="button"
            className={`pane-header-btn ${locked ? 'active' : ''}`}
            disabled={!terminalId}
            draggable={false}
            title={locked ? t('pane.unlock') : t('pane.lock')}
            aria-pressed={locked}
            onClick={() => terminalId && toggleLock(terminalId)}
          >
            <UiIcon name="lock" size="sm" />
          </button>
          <button
            type="button"
            className={`pane-header-btn ${readOnly ? 'active' : ''}`}
            disabled={!terminalId}
            draggable={false}
            title={t('pane.readOnly')}
            aria-pressed={readOnly}
            onClick={() => terminalId && toggleReadOnly(terminalId)}
          >
            <UiIcon name="no-input" size="sm" />
          </button>
          <button
            type="button"
            className="pane-header-btn"
            disabled={!canSplit}
            draggable={false}
            title={splitTitle(t('pane.splitRight'))}
            onClick={() => splitPane(paneId, 'row')}
          >
            <UiIcon name="split-right" size="sm" />
          </button>
          <button
            type="button"
            className="pane-header-btn"
            disabled={!canSplit}
            draggable={false}
            title={splitTitle(t('pane.splitDown'))}
            onClick={() => splitPane(paneId, 'col')}
          >
            <UiIcon name="split-down" size="sm" />
          </button>
          <button
            type="button"
            className={`pane-header-btn ${zoomed ? 'active' : ''}`}
            draggable={false}
            title={zoomed ? t('pane.unzoom') : t('pane.zoom')}
            aria-pressed={zoomed}
            onClick={() => toggleZoom(paneId)}
          >
            <UiIcon name={zoomed ? 'collapse' : 'expand'} size="sm" />
          </button>
          <button
            type="button"
            className="pane-header-btn pane-header-close"
            draggable={false}
            title={t('pane.close')}
            onClick={() => closePane(paneId)}
          >
            ×
          </button>
        </div>
      )}
      {!session && (
        <div className={`pane-empty ${showHeader ? 'has-header' : ''}`} onMouseDownCapture={focus}>
          {pendingConnectionId ? (
            <PanePendingConnection paneId={paneId} connectionId={pendingConnectionId} />
          ) : (
            <TerminalEmptyState paneId={paneId} onNewConnection={onNewConnection} />
          )}
        </div>
      )}
      {searching && terminalId && <PaneSearchBar terminalId={terminalId} hasHeader={showHeader} />}
      <PaneDropZones paneId={paneId} />
    </div>
  )
}

const ZONES: PaneDropZone[] = ['left', 'right', 'top', 'bottom', 'center']

/**
 * Edge targets that turn a tab dragged off the tab bar into a split, or a pane
 * dragged by its header into a swap / move.
 *
 * The overlay stays mounted and goes inert (`pointer-events: none`) between
 * drags rather than unmounting. It sits on top of the xterm host, so it has to
 * be click-through when idle — but it cannot come and go, because the window
 * tracking disarms on `drop` in the capture phase: unmounting there pulls the
 * drop target out of the tree before React dispatches to it, and the drop is
 * silently lost.
 */
function PaneDropZones({ paneId }: { paneId: string }): JSX.Element {
  const splitPaneWithTerminal = usePaneLayoutStore((s) => s.splitPaneWithTerminal)
  const showTerminalInPane = usePaneLayoutStore((s) => s.showTerminalInPane)
  const swapPanes = usePaneLayoutStore((s) => s.swapPanes)
  const movePane = usePaneLayoutStore((s) => s.movePane)
  // A tab or pane drag anywhere in the window arms every pane, so the zones
  // take drops as soon as the drag starts rather than only once the cursor is
  // already inside. The pane being dragged stays inert: it is its own no-op.
  const dragging = useTabDragStore((s) => s.dragging)
  const isSource = useTabDragStore((s) => s.sourcePaneId === paneId)
  const [hover, setHover] = useState<PaneDropZone | null>(null)
  const armed = dragging && !isSource

  /*
   * Decided from the drag payload only, never from `armed`: the disarm has
   * already landed by the time this runs, so this closure sees `armed === false`
   * on every real drop.
   */
  const drop = (zone: PaneDropZone) => (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setHover(null)
    const action = paneDropAction(e.dataTransfer, zone, paneId)
    if (!action) return
    switch (action.kind) {
      case 'swapPanes':
        swapPanes(action.sourcePaneId, paneId)
        return
      case 'movePane':
        movePane(action.sourcePaneId, paneId, action.dir, action.before)
        return
      case 'showTerminal':
        showTerminalInPane(paneId, action.terminalId)
        return
      case 'splitWithTerminal':
        splitPaneWithTerminal(paneId, action.dir, action.terminalId, action.before)
        return
    }
  }

  return (
    <div className={`pane-drops ${armed ? 'is-armed' : ''}`}>
      {ZONES.map((zone) => (
        <div
          key={zone}
          className={`pane-drop pane-drop--${zone} ${armed && hover === zone ? 'is-over' : ''}`}
          onDragEnter={() => setHover(zone)}
          onDragOver={(e) => {
            if (!isLayoutDrag(e.dataTransfer)) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            if (hover !== zone) setHover(zone)
          }}
          onDragLeave={() => setHover((h) => (h === zone ? null : h))}
          onDrop={drop(zone)}
        />
      ))}
    </div>
  )
}

/**
 * A pane restored from a saved layout, waiting on its host.
 *
 * Restoring a workspace deliberately does not dial: opening four production
 * hosts because a menu item was clicked is not something to do on the user's
 * behalf, so the pane just names the target and offers the button.
 */
function PanePendingConnection({
  paneId,
  connectionId
}: {
  paneId: string
  connectionId: string
}): JSX.Element {
  const t = useT()
  const conn = useBookmarksStore((s) => s.connections.find((c) => c.id === connectionId))
  const clearPending = usePaneLayoutStore((s) => s.clearPending)
  const [busy, setBusy] = useState(false)

  if (!conn) {
    return (
      <div className="pane-pending">
        <div className="pane-pending-title">{t('pane.pendingMissing')}</div>
        <button type="button" className="pane-pending-btn" onClick={() => clearPending(paneId)}>
          {t('pane.pendingDismiss')}
        </button>
      </div>
    )
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    try {
      await connectFromConfig(conn, { paneId })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pane-pending">
      <div className="pane-pending-label">{t('pane.pendingLabel')}</div>
      <div className="pane-pending-title">{conn.name || `${conn.username}@${conn.host}`}</div>
      <div className="pane-pending-sub">{`${conn.username}@${conn.host}:${conn.port || 22}`}</div>
      <button
        type="button"
        className="pane-pending-btn"
        disabled={busy}
        onClick={() => void connect()}
      >
        {busy ? t('pane.pendingConnecting') : t('pane.pendingConnect')}
      </button>
    </div>
  )
}

/** One keyboard nudge of a divider, as a fraction of its split. */
const RATIO_STEP = 0.02

/** Thin drag strip centred on a split boundary. */
function PaneDividerHandle({ divider }: { divider: PaneDivider }): JSX.Element {
  const t = useT()
  const setRatio = usePaneLayoutStore((s) => s.setRatio)
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  const ref = useRef<HTMLDivElement>(null)
  const horizontal = divider.dir === 'row'

  const style = horizontal
    ? {
        left: `calc(${divider.pos}% - 3px)`,
        top: `${divider.rect.top}%`,
        width: '6px',
        height: `${divider.rect.height}%`
      }
    : {
        left: `${divider.rect.left}%`,
        top: `calc(${divider.pos}% - 3px)`,
        width: `${divider.rect.width}%`,
        height: '6px'
      }

  /**
   * Pixel box of the split this divider belongs to. The handle is absolutely
   * positioned inside `.terminal-area`, so its offset parent is the element the
   * percentages were derived from.
   */
  const measureBand = (): { start: number; size: number } | null => {
    const host = ref.current?.offsetParent as HTMLElement | null
    if (!host) return null
    const hostRect = host.getBoundingClientRect()
    const start = horizontal
      ? hostRect.left + (divider.rect.left / 100) * hostRect.width
      : hostRect.top + (divider.rect.top / 100) * hostRect.height
    const size = horizontal
      ? (divider.rect.width / 100) * hostRect.width
      : (divider.rect.height / 100) * hostRect.height
    return size > 0 ? { start, size } : null
  }

  /*
   * Pointer capture, not window listeners: releasing the button outside the
   * window never delivers a `mouseup`, which used to leave the divider glued to
   * the cursor. Capture also keeps the moves away from the xterm underneath, so
   * dragging across a terminal cannot start a text selection.
   */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    if (!measureBand()) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // The ref gates the moves and the state only drives the class, because a
    // move can arrive before React has re-rendered with `dragging` true.
    draggingRef.current = true
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    const band = measureBand()
    if (!band) return
    const pos = horizontal ? e.clientX : e.clientY
    setRatio(divider.splitId, (pos - band.start) / band.size, band.size)
  }

  const stopDrag = (): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    stopDrag()
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const nudge = (delta: number): void => {
    setRatio(divider.splitId, divider.ratio + delta, measureBand()?.size)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Modified arrows belong to the pane-focus shortcuts, which stay reachable
    // even while a divider happens to hold focus.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp'
    const forward = horizontal ? 'ArrowRight' : 'ArrowDown'
    if (e.key === back) nudge(-RATIO_STEP)
    else if (e.key === forward) nudge(RATIO_STEP)
    else if (e.key === 'Home' || e.key === 'Enter') setRatio(divider.splitId, 0.5, measureBand()?.size)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={ref}
      className={`pane-divider pane-divider--${divider.dir} ${dragging ? 'dragging' : ''}`}
      style={style}
      role="separator"
      tabIndex={0}
      title={t('pane.dividerHint')}
      aria-label={t('pane.dividerHint')}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(divider.ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={stopDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setRatio(divider.splitId, 0.5, measureBand()?.size)}
    />
  )
}
