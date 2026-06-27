import { useEffect, useRef, useState } from 'react'
import { useBookmarksStore, type TreeNode } from '../../store/bookmarksStore'
import {
  useConnSidebarStore,
  clampConnSidebarWidth,
  CONN_SIDEBAR_MIN_WIDTH,
  CONN_SIDEBAR_MAX_WIDTH
} from '../../store/connSidebarStore'
import { useTabsStore } from '../../store/tabsStore'
import { connectFromConfig } from '../../lib/connect'
import { useT } from '../../lib/i18n'
import ContextMenuItem from '../ContextMenuItem'
import UiIcon from '../UiIcon'
import type { ConnectionConfig } from '../../../shared/types'

interface Props {
  onNewConnection: (parentId: string | null) => void
  onEditConnection: (conn: ConnectionConfig) => void
  onClose: () => void
}

type DropPos = 'before' | 'after' | 'inside'

interface Menu {
  x: number
  y: number
  node: TreeNode | null // null => background (root)
}

export default function ConnectionSidebar({
  onNewConnection,
  onEditConnection,
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
    move
  } = useBookmarksStore()
  // Subscribe to the raw arrays so the tree re-renders on any change.
  const folders = useBookmarksStore((s) => s.folders)
  const connections = useBookmarksStore((s) => s.connections)
  const tabs = useTabsStore((s) => s.tabs)
  const { panelWidth, setPanelWidth } = useConnSidebarStore()
  const t = useT()

  const tree = getTree()

  const [menu, setMenu] = useState<Menu | null>(null)
  const [resizing, setResizing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: DropPos } | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) renameRef.current?.focus()
  }, [renamingId])

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

  const isConnectionActive = (c: ConnectionConfig): boolean =>
    tabs.some((t) => t.status === 'connected' && t.host === c.host && t.username === c.username)

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

    const active = isConnectionActive(node.connection)
    const selected = selectedId === node.id
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
        onDoubleClick={() => void connectFromConfig(node.connection)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setSelectedId(node.id)
          setMenu({ x: e.clientX, y: e.clientY, node })
        }}
        title={`${node.connection.username}@${node.connection.host}:${node.connection.port}`}
      >
        <span className={`conn-dot ${active ? 'active' : ''}`} />
        <span className="tree-label">{node.connection.name}</span>
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
          <button className="toolbar-btn toolbar-btn--icon" title={t('sidebar.newFolder')} onClick={() => void newFolder(null)}>
            <UiIcon name="folder-plus" />
          </button>
          <button className="toolbar-btn toolbar-btn--icon" title={t('sidebar.hide')} onClick={onClose}>
            <UiIcon name="panel-close" />
          </button>
        </div>
      </div>

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
        {tree.length === 0 ? (
          <div className="conn-empty" style={{ whiteSpace: 'pre-line' }}>
            {t('sidebar.empty')}
          </div>
        ) : (
          tree.map((node) => renderNode(node, 0))
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
          {menu.node === null && (
            <>
              <ContextMenuItem icon="connect" onClick={() => onNewConnection(null)}>
                {t('sidebar.newConnection')}
              </ContextMenuItem>
              <ContextMenuItem icon="folder-new" onClick={() => void newFolder(null)}>
                {t('sidebar.newFolder')}
              </ContextMenuItem>
            </>
          )}
          {menu.node?.kind === 'folder' && (
            <>
              <ContextMenuItem icon="connect" onClick={() => onNewConnection(menu.node!.id)}>
                {t('sidebar.newConnectionHere')}
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
