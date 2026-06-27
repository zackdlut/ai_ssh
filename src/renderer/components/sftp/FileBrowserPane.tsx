import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../lib/i18n'
import SftpPathField from './SftpPathField'
import {
  formatSize,
  formatTime,
  parentDir,
  sortEntries,
  toggleSelection,
  type FileEntry,
  type SortColumn,
  type SortDirection
} from './utils'

export interface FileBrowserPaneProps {
  title: string
  cwd: string
  entries: FileEntry[]
  loading: boolean
  disabled?: boolean
  selected: Set<string>
  onSelectedChange: (next: Set<string>) => void
  onNavigate: (path: string) => void
  onBrowse?: () => void
  toolbarExtra?: React.ReactNode
  titleActions?: React.ReactNode
  titleProgress?: React.ReactNode
  titleResize?: {
    resizing?: boolean
    tip?: string
    onMouseDown: (e: React.MouseEvent) => void
    onDoubleClick?: (e: React.MouseEvent) => void
  }
  renderRowActions?: (entry: FileEntry) => React.ReactNode
  onRowContextMenu?: (entry: FileEntry, e: React.MouseEvent) => void
  emptyMessage?: string
}

export default function FileBrowserPane({
  title,
  cwd,
  entries,
  loading,
  disabled = false,
  selected,
  onSelectedChange,
  onNavigate,
  onBrowse,
  toolbarExtra,
  titleActions,
  titleProgress,
  titleResize,
  renderRowActions,
  onRowContextMenu,
  emptyMessage
}: FileBrowserPaneProps): JSX.Element {
  const t = useT()
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)
  const [sortColumn, setSortColumn] = useState<SortColumn>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  useEffect(() => {
    setHoveredPath(null)
  }, [cwd, entries])

  useEffect(() => {
    setSortColumn('name')
    setSortDirection('asc')
  }, [cwd])

  const sortedEntries = useMemo(
    () => sortEntries(entries, sortColumn, sortDirection),
    [entries, sortColumn, sortDirection]
  )

  const toggleSort = (column: SortColumn): void => {
    if (sortColumn === column) {
      setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortColumn(column)
    setSortDirection('asc')
  }

  const sortTitle = (column: SortColumn, label: string): string => {
    if (sortColumn !== column) return label
    return `${label} (${sortDirection === 'asc' ? '↑' : '↓'})`
  }

  const goUp = (): void => {
    if (cwd) onNavigate(parentDir(cwd))
  }

  const allPaths = sortedEntries.map((e) => e.path)

  const handleRowClick = (entry: FileEntry, e: React.MouseEvent): void => {
    if (disabled) return
    onSelectedChange(
      toggleSelection(selected, entry.path, allPaths, {
        shift: e.shiftKey,
        toggle: e.metaKey || e.ctrlKey
      })
    )
  }

  const handleRowDoubleClick = (entry: FileEntry): void => {
    if (disabled) return
    if (entry.type === 'dir' || entry.type === 'link') onNavigate(entry.path)
  }

  return (
    <div className="sftp-pane">
      <div
        className={`sftp-pane-title ${titleResize ? 'sftp-pane-title-resize' : ''} ${titleResize?.resizing ? 'active' : ''}`}
        role={titleResize ? 'separator' : undefined}
        aria-orientation={titleResize ? 'horizontal' : undefined}
        aria-label={titleResize ? titleResize.tip : undefined}
        data-tip={titleResize?.tip}
        onMouseDown={titleResize?.onMouseDown}
        onDoubleClick={titleResize?.onDoubleClick}
      >
        <span className="sftp-pane-title-main">
          <span className="sftp-pane-title-label">{title}</span>
          {titleProgress}
        </span>
        {titleActions && (
          <span className="sftp-pane-title-actions" onMouseDown={(e) => e.stopPropagation()}>
            {titleActions}
          </span>
        )}
      </div>
      <div className="sftp-toolbar">
        <button
          className="sftp-btn-icon sftp-btn-icon-up"
          onClick={goUp}
          disabled={disabled || !cwd}
          title={t('sftp.up')}
          aria-label={t('sftp.up')}
        />
        <SftpPathField
          cwd={cwd}
          disabled={disabled}
          onNavigate={onNavigate}
          onBrowse={onBrowse}
        />
        {toolbarExtra}
      </div>
      <div className="sftp-list">
        {!loading && entries.length > 0 && (
          <div className="sftp-list-head">
            <span className="sftp-col-icon" aria-hidden />
            <button
              type="button"
              className={`sftp-col-sort sftp-col-name ${sortColumn === 'name' ? `active ${sortDirection}` : ''}`}
              onClick={() => toggleSort('name')}
              title={sortTitle('name', t('sftp.name'))}
            >
              {t('sftp.name')}
              <span className="sftp-col-sort-indicator" aria-hidden />
            </button>
            <button
              type="button"
              className={`sftp-col-sort sftp-col-size ${sortColumn === 'size' ? `active ${sortDirection}` : ''}`}
              onClick={() => toggleSort('size')}
              title={sortTitle('size', t('sftp.size'))}
            >
              {t('sftp.size')}
              <span className="sftp-col-sort-indicator" aria-hidden />
            </button>
            <button
              type="button"
              className={`sftp-col-sort sftp-col-time ${sortColumn === 'mtime' ? `active ${sortDirection}` : ''}`}
              onClick={() => toggleSort('mtime')}
              title={sortTitle('mtime', t('sftp.modified'))}
            >
              {t('sftp.modified')}
              <span className="sftp-col-sort-indicator" aria-hidden />
            </button>
            <span className="sftp-col-actions" aria-hidden />
          </div>
        )}
        {loading ? (
          <div className="sftp-empty">{t('sftp.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="sftp-empty">{emptyMessage ?? t('sftp.emptyDir')}</div>
        ) : (
          sortedEntries.map((entry) => (
            <div
              key={entry.path}
              className={`sftp-row ${entry.type} ${selected.has(entry.path) ? 'selected' : ''} ${hoveredPath === entry.path ? 'is-hovered' : ''}`}
              onClick={(e) => handleRowClick(entry, e)}
              onDoubleClick={() => handleRowDoubleClick(entry)}
              onMouseEnter={() => setHoveredPath(entry.path)}
              onMouseLeave={() => setHoveredPath((path) => (path === entry.path ? null : path))}
              onContextMenu={
                onRowContextMenu
                  ? (e) => {
                      e.preventDefault()
                      onRowContextMenu(entry, e)
                    }
                  : undefined
              }
            >
              <span className={`sftp-entry-icon ${entry.type}`} aria-hidden />
              <span className="sftp-name" title={entry.name}>
                {entry.name}
              </span>
              <span className="sftp-size">{entry.type === 'dir' ? '' : formatSize(entry.size)}</span>
              <span className="sftp-time">{formatTime(entry.mtime)}</span>
              <span className="sftp-actions" onClick={(e) => e.stopPropagation()}>
                {renderRowActions?.(entry)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function selectedTransferPaths(selected: Set<string>, entries: FileEntry[]): string[] {
  const pathSet = new Set(entries.map((e) => e.path))
  return [...selected].filter((p) => pathSet.has(p))
}
