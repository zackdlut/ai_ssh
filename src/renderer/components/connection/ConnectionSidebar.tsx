import { useEffect, useRef, useState } from 'react'
import { useBookmarksStore, type TreeNode } from '../../store/bookmarksStore'
import { useTabsStore } from '../../store/tabsStore'
import { connectFromConfig } from '../../lib/connect'
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

  const tree = getTree()

  const [menu, setMenu] = useState<Menu | null>(null)
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
    await addFolder('新建文件夹', parentId)
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
    <div className="conn-sidebar">
      <div className="conn-sidebar-header">
        <div className="conn-sidebar-title-wrap">
          <span className="conn-sidebar-title">连接</span>
          {connections.length > 0 && (
            <span className="conn-count" title={`${connections.length} 个已保存连接`}>
              {connections.length}
            </span>
          )}
        </div>
        <div className="conn-sidebar-actions">
          <button
            className="icon-btn"
            title="新建连接"
            onClick={() => onNewConnection(null)}
          >
            +
          </button>
          <button
            className="icon-btn"
            title="新建文件夹"
            onClick={() => void newFolder(null)}
          >
            ⊕
          </button>
          <button className="icon-btn" title="隐藏侧栏" onClick={onClose}>
            ‹
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
          <div className="conn-empty">
            还没有保存的连接。
            <br />
            点 + 新建连接，或右键新建分组。
          </div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.node === null && (
            <>
              <button onClick={() => onNewConnection(null)}>新建连接</button>
              <button onClick={() => void newFolder(null)}>新建文件夹</button>
            </>
          )}
          {menu.node?.kind === 'folder' && (
            <>
              <button onClick={() => onNewConnection(menu.node!.id)}>在此新建连接</button>
              <button onClick={() => void newFolder(menu.node!.id)}>新建子文件夹</button>
              <button
                onClick={() =>
                  beginRename(menu.node!.id, (menu.node as { folder: { name: string } }).folder.name)
                }
              >
                重命名
              </button>
              <button onClick={() => void deleteFolder(menu.node!.id)}>删除文件夹</button>
            </>
          )}
          {menu.node?.kind === 'connection' && (
            <>
              <button
                onClick={() =>
                  void connectFromConfig(
                    (menu.node as { connection: ConnectionConfig }).connection
                  )
                }
              >
                连接
              </button>
              <button
                onClick={() =>
                  onEditConnection((menu.node as { connection: ConnectionConfig }).connection)
                }
              >
                编辑
              </button>
              <button onClick={() => void deleteConnection(menu.node!.id)}>删除</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
