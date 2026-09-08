import { useEffect, useRef, useState } from 'react'
import { useBookmarksStore, type TreeNode } from '../../store/bookmarksStore'
import {
  useConnSidebarStore,
  clampConnSidebarWidth,
  CONN_SIDEBAR_MIN_WIDTH,
  CONN_SIDEBAR_MAX_WIDTH
} from '../../store/connSidebarStore'
import { useSessionsStore } from '../../store/sessionsStore'
import { useDevicesStore } from '../../store/devicesStore'
import { connectFromConfig } from '../../lib/connect'
import { useT } from '../../lib/i18n'
import ContextMenuItem from '../ContextMenuItem'
import UiIcon from '../UiIcon'
import DiscoveredDevices from './DiscoveredDevices'
import SerialPortMenu, { SavedSerialMenuItems } from './SerialPortMenu'
import { deviceIconName } from './deviceIcon'
import { deviceKindLabel, type SerialPortInfo } from '../../../shared/deviceIdentity'
import type {
  BookmarkTransferFormat,
  ConnectionConfig,
  DeviceProbeResult
} from '../../../shared/types'

interface Props {
  onNewConnection: (parentId: string | null) => void
  onEditConnection: (conn: ConnectionConfig) => void
  /** Open the serial dialog, optionally pre-filled with a discovered port. */
  onNewSerial: (path?: string) => void
  /** Open the dialog that saves a local shell as a bookmark. */
  onNewLocalShell: () => void
  onClose: () => void
}

type DropPos = 'before' | 'after' | 'inside'

/** Row tooltip: the address for an SSH host, the port settings for a device. */
function describeConnection(c: ConnectionConfig, probe?: DeviceProbeResult): string {
  if (c.kind === 'serial') {
    const parts = [c.serial?.path ?? '(no port)']
    if (c.serial?.baudRate) parts.push(`${c.serial.baudRate} baud`)
    if (c.deviceKind) parts.push(deviceKindLabel(c.deviceKind))
    return parts.join(' · ')
  }
  if (c.kind === 'local') {
    const parts = [c.local?.shell ?? 'default shell']
    if (c.local?.cwd) parts.push(c.local.cwd)
    return parts.join(' · ')
  }
  const address = `${c.username}@${c.host}:${c.port}`
  if (!probe) return address
  if (probe.reachable) return `${address} · ${probe.latencyMs ?? '?'}ms`
  return `${address} · ${probe.error ?? 'unreachable'}`
}

interface Menu {
  x: number
  y: number
  node: TreeNode | null // null => background (root)
  /** Import/export menu opened from the toolbar rather than a right-click. */
  transfer?: boolean
  /**
   * A discovered serial port, which is not a tree node at all: it has no id,
   * no folder, and cannot be renamed or deleted, because it is a fact about
   * what is plugged in rather than a record the user created.
   */
  port?: SerialPortInfo
}

export default function ConnectionSidebar({
  onNewConnection,
  onEditConnection,
  onNewSerial,
  onNewLocalShell,
  onClose
}: Props): JSX.Element {
  const {
    expanded,
    toggleExpanded,
    getTree,
    addFolder,
    renameFolder,
    deleteFolder,
    deleteConnection,
    importSessions,
    move
  } = useBookmarksStore()
  // Subscribe to the raw arrays so the tree re-renders on any change.
  const folders = useBookmarksStore((s) => s.folders)
  const connections = useBookmarksStore((s) => s.connections)
  const tabs = useSessionsStore((s) => s.sessions)
  const probes = useDevicesStore((s) => s.probes)
  const acquireDevices = useDevicesStore((s) => s.acquire)
  const { panelWidth, setPanelWidth } = useConnSidebarStore()
  const t = useT()

  // Serial enumeration wakes the USB bus and probing touches every saved
  // device, so both run only while this panel is mounted.
  useEffect(() => acquireDevices(), [acquireDevices])

  const tree = getTree()

  const [menu, setMenu] = useState<Menu | null>(null)
  const [resizing, setResizing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: DropPos } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) renameRef.current?.focus()
  }, [renamingId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  /**
   * Whether a saved entry has a live session, for the row's dot.
   *
   * The hostless branches are not a nicety: neither a serial nor a local entry
   * stores a host or user, so the host comparison would be `'' === ''` and every
   * one of them would light up the moment any one was opened. A serial session
   * is identified by the port it holds, and a local one by the shell it runs.
   */
  const isConnectionActive = (c: ConnectionConfig): boolean => {
    if (c.kind === 'serial') {
      return tabs.some(
        (t) =>
          t.status === 'connected' &&
          t.kind === 'serial' &&
          !!c.serial?.path &&
          t.serialOpts?.path === c.serial.path
      )
    }
    if (c.kind === 'local') {
      return tabs.some(
        (t) => t.status === 'connected' && t.kind === 'local' && t.connectionId === c.id
      )
    }
    return tabs.some(
      (t) =>
        t.status === 'connected' &&
        t.kind !== 'serial' &&
        t.kind !== 'local' &&
        !!c.host &&
        t.host === c.host &&
        t.username === c.username
    )
  }

  // --- ordered siblings of a parent (mirrors buildTree ordering) ---
  const childrenOf = (parentId: string | null): TreeNode[] => {
    if (parentId === null) return tree
    let found: TreeNode[] | null = null
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.kind === 'folder') {
          if (n.id === parentId) found = n.children
          else walk(n.children)
        }
      }
    }
    walk(tree)
    return found ?? []
  }

  const parentOf = (nodeId: string): string | null => {
    const f = folders.find((x) => x.id === nodeId)
    if (f) return f.parentId ?? null
    const c = connections.find((x) => x.id === nodeId)
    return c ? (c.parentId ?? null) : null
  }

  // --- rename helpers ---
  const beginRename = (id: string, current: string): void => {
    setRenamingId(id)
    setRenameValue(current)
    setMenu(null)
  }
  const commitRename = (): void => {
    if (renamingId) void renameFolder(renamingId, renameValue)
    setRenamingId(null)
  }

  const newFolder = async (parentId: string | null): Promise<void> => {
    setMenu(null)
    await addFolder(t('sidebar.newFolderDefault'), parentId)
    // Put the freshly created folder into rename mode.
    const created = useBookmarksStore
      .getState()
      .folders.filter((f) => (f.parentId ?? null) === (parentId ?? null))
      .reduce<typeof folders[number] | null>(
        (acc, f) => (acc && acc.order >= f.order ? acc : f),
        null
      )
    if (created) beginRename(created.id, created.name)
  }

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  const runImport = async (format: BookmarkTransferFormat): Promise<void> => {
    setMenu(null)
    if (busy) return
    setBusy(true)
    try {
      const result = await importSessions(format)
      if (result.cancelled) return
      if (result.error) {
        setNotice({ text: t('sidebar.importFailed', { error: result.error }), error: true })
        return
      }
      setNotice({
        text: t('sidebar.importDone', {
          imported: result.imported ?? 0,
          updated: result.updated ?? 0,
          skipped: result.skipped ?? 0
        })
      })
    } catch (e) {
      // A rejected invoke (missing IPC handler, stale preload) would otherwise
      // disappear into an unhandled rejection and look like a dead button.
      setNotice({ text: t('sidebar.importFailed', { error: errText(e) }), error: true })
    } finally {
      setBusy(false)
    }
  }

  const runExport = async (format: BookmarkTransferFormat): Promise<void> => {
    setMenu(null)
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.config.exportSessions(format)
      if (result.cancelled) return
      if (result.error) {
        setNotice({ text: t('sidebar.exportFailed', { error: result.error }), error: true })
        return
      }
      // Say so when the format could not carry everything, rather than letting
      // a count quietly smaller than the sidebar look like a successful export.
      const skipped = result.skipped ?? 0
      setNotice({
        text: skipped
          ? t('sidebar.exportDoneSkipped', {
              exported: result.exported ?? 0,
              skipped,
              path: result.path ?? ''
            })
          : t('sidebar.exportDone', {
              exported: result.exported ?? 0,
              path: result.path ?? ''
            })
      })
    } catch (e) {
      setNotice({ text: t('sidebar.exportFailed', { error: errText(e) }), error: true })
    } finally {
      setBusy(false)
    }
  }

  // --- drag & drop ---
  const onDragStart = (e: React.DragEvent, id: string): void => {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  const onNodeDragOver = (e: React.DragEvent, node: TreeNode): void => {
    if (!dragId || dragId === node.id) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    let pos: DropPos
    if (node.kind === 'folder') {
      pos = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside'
    } else {
      pos = ratio < 0.5 ? 'before' : 'after'
    }
    setDropTarget({ id: node.id, pos })
  }
  const onNodeDrop = async (e: React.DragEvent, node: TreeNode): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const target = dropTarget
    const dragged = dragId
    setDropTarget(null)
    setDragId(null)
    if (!dragged || !target || dragged === node.id) return

    if (target.pos === 'inside' && node.kind === 'folder') {
      await move(dragged, node.id, null)
      useBookmarksStore.getState().setExpanded(node.id, true)
      return
    }
    const parent = parentOf(node.id)
    const siblings = childrenOf(parent).filter((n) => n.id !== dragged)
    const idx = siblings.findIndex((n) => n.id === node.id)
    if (target.pos === 'before') {
      await move(dragged, parent, node.id)
    } else {
      const next = siblings[idx + 1]
      await move(dragged, parent, next ? next.id : null)
    }
  }
  const onRootDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    const dragged = dragId
    setDropTarget(null)
    setDragId(null)
    if (dragged) await move(dragged, null, null)
  }

  // Drag the right edge to resize. Dragging right widens the sidebar.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidth
    setResizing(true)

    const onMove = (ev: MouseEvent): void => {
      setPanelWidth(startWidth + (ev.clientX - startX))
    }
    const onUp = (): void => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const onHandleKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight') setPanelWidth(panelWidth + 24)
    else if (e.key === 'ArrowLeft') setPanelWidth(panelWidth - 24)
  }

  const renderNode = (node: TreeNode, depth: number): JSX.Element => {
    const pad = 8 + depth * 14
    const isDropInside = dropTarget?.id === node.id && dropTarget.pos === 'inside'
    const isDropBefore = dropTarget?.id === node.id && dropTarget.pos === 'before'
    const isDropAfter = dropTarget?.id === node.id && dropTarget.pos === 'after'
    const dropCls = `${isDropInside ? 'drop-inside' : ''} ${isDropBefore ? 'drop-before' : ''} ${
      isDropAfter ? 'drop-after' : ''
    }`.trim()

    if (node.kind === 'folder') {
      const open = expanded[node.id] ?? true
      const renaming = renamingId === node.id
      return (
        <div key={node.id}>
          <div
            className={`tree-row folder ${dropCls}`}
            style={{ paddingLeft: pad }}
            draggable={!renaming}
            onDragStart={(e) => onDragStart(e, node.id)}
            onDragOver={(e) => onNodeDragOver(e, node)}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => void onNodeDrop(e, node)}
            onClick={() => !renaming && toggleExpanded(node.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ x: e.clientX, y: e.clientY, node })
            }}
          >
            <span className={`caret ${open ? 'open' : ''}`}>▸</span>
            <span className="tree-icon folder-icon" />
            {renaming ? (
              <input
                ref={renameRef}
                className="rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  // Ignore Enter while the IME is composing (confirming a
                  // Chinese candidate), otherwise rename commits mid-input.
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') setRenamingId(null)
                }}
              />
            ) : (
              <span className="tree-label">{node.folder.name}</span>
            )}
          </div>
          {open && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      )
    }

    const conn = node.connection
    const active = isConnectionActive(conn)
    const selected = selectedId === node.id
    // Nothing to reach over the network, so nothing to probe.
    const probe = conn.kind === 'serial' || conn.kind === 'local' ? undefined : probes[conn.id]
    return (
      <div
        key={node.id}
        className={`tree-row connection ${selected ? 'selected' : ''} ${dropCls}`}
        style={{ paddingLeft: pad }}
        draggable
        onDragStart={(e) => onDragStart(e, node.id)}
        onDragOver={(e) => onNodeDragOver(e, node)}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => void onNodeDrop(e, node)}
        onClick={() => setSelectedId(node.id)}
        onDoubleClick={() => void connectFromConfig(conn)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setSelectedId(node.id)
          setMenu({ x: e.clientX, y: e.clientY, node })
        }}
        title={describeConnection(conn, probe)}
      >
        {/*
          Three states, not two. `active` means this app has a session open;
          `probe.reachable` means the device answers but nothing is connected —
          which for a Pi that dropped off the network is the distinction the
          user is looking for. A serial device gets no probe: its presence in
          the discovered list is the answer.
        */}
        <span
          className={`conn-dot ${
            active ? 'active' : probe ? (probe.reachable ? 'reachable' : 'unreachable') : ''
          }`}
        />
        {conn.deviceKind && (
          <UiIcon name={deviceIconName(conn.deviceKind)} size="sm" className="device-icon" />
        )}
        <span className="tree-label">{conn.name}</span>
        {probe?.reachable && probe.latencyMs !== undefined && (
          <span className="device-latency">{probe.latencyMs}ms</span>
        )}
      </div>
    )
  }

  return (
    <div className="side-panel conn-sidebar" style={{ width: panelWidth }}>
      <div className="side-panel-header">
        <span className="panel-title">
          <span className="spark" />
          {t('sidebar.title')}
          {connections.length > 0 && (
            <span className="conn-count" title={t('sidebar.savedCount', { count: connections.length })}>
              {connections.length}
            </span>
          )}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="toolbar-btn toolbar-btn--icon" title={t('sidebar.newConnection')} onClick={() => onNewConnection(null)}>
            <UiIcon name="plus" />
          </button>
          <button
            className="toolbar-btn toolbar-btn--icon"
            title={t('sidebar.newSerial')}
            onClick={() => onNewSerial()}
          >
            <UiIcon name="serial" />
          </button>
          <button
            className="toolbar-btn toolbar-btn--icon"
            title={t('sidebar.newLocalShell')}
            onClick={() => onNewLocalShell()}
          >
            <UiIcon name="terminal" />
          </button>
          <button className="toolbar-btn toolbar-btn--icon" title={t('sidebar.newFolder')} onClick={() => void newFolder(null)}>
            <UiIcon name="folder-plus" />
          </button>
          <button
            className="toolbar-btn toolbar-btn--icon"
            title={t('sidebar.transfer')}
            disabled={busy}
            onClick={(e) => {
              // Every other menu here opens from `contextmenu`, so the dismiss
              // listener on `window` never saw the opening event. Keep this
              // click off `window` so it can't race that listener.
              e.stopPropagation()
              if (menu?.transfer) {
                setMenu(null)
                return
              }
              const rect = e.currentTarget.getBoundingClientRect()
              setMenu({ x: rect.left, y: rect.bottom + 4, node: null, transfer: true })
            }}
          >
            <UiIcon name="import" />
          </button>
          <button className="toolbar-btn toolbar-btn--icon" title={t('sidebar.hide')} onClick={onClose}>
            <UiIcon name="panel-close" />
          </button>
        </div>
      </div>

      {notice && (
        <div
          className={`conn-notice ${notice.error ? 'error' : ''}`}
          role="status"
          onClick={() => setNotice(null)}
        >
          {notice.text}
        </div>
      )}

      <div
        className="conn-tree"
        onDragOver={(e) => {
          if (dragId) e.preventDefault()
        }}
        onDrop={(e) => void onRootDrop(e)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, node: null })
        }}
      >
        <DiscoveredDevices
          onConfigure={(path) => onNewSerial(path)}
          onPortMenu={(e, port) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, node: null, port })
          }}
        />

        {tree.length === 0 ? (
          <div className="conn-empty" style={{ whiteSpace: 'pre-line' }}>
            {t('sidebar.empty')}
          </div>
        ) : (
          <div className="device-section">
            <div className="device-section-header device-section-header--static">
              <span className="device-section-title">{t('devices.saved')}</span>
            </div>
            {tree.map((node) => renderNode(node, 0))}
          </div>
        )}
      </div>

      <div
        className={`panel-resizer panel-resizer-right ${resizing ? 'active' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resizeLabel')}
        aria-valuemin={CONN_SIDEBAR_MIN_WIDTH}
        aria-valuemax={CONN_SIDEBAR_MAX_WIDTH}
        aria-valuenow={clampConnSidebarWidth(panelWidth)}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={onHandleKey}
        onDoubleClick={() => setPanelWidth(256)}
        data-tip={t('sidebar.resizeTip')}
      />

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.port && (
            <SerialPortMenu
              port={menu.port}
              onConfigure={(path) => onNewSerial(path)}
              onNotice={(text, error) => setNotice({ text, error })}
            />
          )}
          {menu.node === null && !menu.transfer && !menu.port && (
            <>
              <ContextMenuItem icon="connect" onClick={() => onNewConnection(null)}>
                {t('sidebar.newConnection')}
              </ContextMenuItem>
              <ContextMenuItem icon="serial" onClick={() => onNewSerial()}>
                {t('sidebar.newSerial')}
              </ContextMenuItem>
              <ContextMenuItem icon="terminal" onClick={() => onNewLocalShell()}>
                {t('sidebar.newLocalShell')}
              </ContextMenuItem>
              <ContextMenuItem icon="folder-new" onClick={() => void newFolder(null)}>
                {t('sidebar.newFolder')}
              </ContextMenuItem>
            </>
          )}
          {menu.transfer && (
            <>
              <ContextMenuItem icon="import" onClick={() => void runImport('xml')}>
                {t('sidebar.importXml')}
              </ContextMenuItem>
              <ContextMenuItem
                icon="export"
                disabled={connections.length === 0}
                onClick={() => void runExport('xml')}
              >
                {t('sidebar.exportXml')}
              </ContextMenuItem>
              <div className="context-menu-divider" role="separator" />
              <ContextMenuItem icon="import" onClick={() => void runImport('json')}>
                {t('sidebar.importJson')}
              </ContextMenuItem>
              <ContextMenuItem
                icon="export"
                disabled={connections.length === 0}
                onClick={() => void runExport('json')}
              >
                {t('sidebar.exportJson')}
              </ContextMenuItem>
            </>
          )}
          {menu.node?.kind === 'folder' && (
            <>
              <ContextMenuItem icon="connect" onClick={() => onNewConnection(menu.node!.id)}>
                {t('sidebar.newConnectionHere')}
              </ContextMenuItem>
              <ContextMenuItem icon="serial" onClick={() => onNewSerial()}>
                {t('sidebar.newSerial')}
              </ContextMenuItem>
              <ContextMenuItem icon="terminal" onClick={() => onNewLocalShell()}>
                {t('sidebar.newLocalShell')}
              </ContextMenuItem>
              <ContextMenuItem icon="folder-new" onClick={() => void newFolder(menu.node!.id)}>
                {t('sidebar.newSubfolder')}
              </ContextMenuItem>
              <ContextMenuItem
                icon="edit"
                onClick={() =>
                  beginRename(menu.node!.id, (menu.node as { folder: { name: string } }).folder.name)
                }
              >
                {t('common.rename')}
              </ContextMenuItem>
              <ContextMenuItem icon="delete" onClick={() => void deleteFolder(menu.node!.id)}>
                {t('sidebar.deleteFolder')}
              </ContextMenuItem>
            </>
          )}
          {menu.node?.kind === 'connection' && (
            <>
              <ContextMenuItem
                icon="connect"
                onClick={() =>
                  void connectFromConfig(
                    (menu.node as { connection: ConnectionConfig }).connection
                  )
                }
              >
                {t('common.connect')}
              </ContextMenuItem>
              <ContextMenuItem
                icon="edit"
                onClick={() =>
                  onEditConnection((menu.node as { connection: ConnectionConfig }).connection)
                }
              >
                {t('common.edit')}
              </ContextMenuItem>
              <ContextMenuItem icon="delete" onClick={() => void deleteConnection(menu.node!.id)}>
                {t('common.delete')}
              </ContextMenuItem>
              {/* A saved serial device gets the same live actions as a
                  discovered port, so the two rows do not disagree about what
                  can be done to one board. */}
              {(menu.node as { connection: ConnectionConfig }).connection.kind === 'serial' && (
                <SavedSerialMenuItems
                  conn={(menu.node as { connection: ConnectionConfig }).connection}
                  onNotice={(text, error) => setNotice({ text, error })}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
