import { useCallback, useEffect, useRef, useState } from 'react'
import { clampPanelWidth, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '../../store/aiStore'
import { useSftpStore } from '../../store/sftpStore'
import { useTabsStore } from '../../store/tabsStore'
import { useT } from '../../lib/i18n'
import type { LocalEntry, SftpEntry, SftpTransferProgress } from '../../../shared/types'
import ContextMenuItem from '../ContextMenuItem'
import UiIcon from '../UiIcon'
import FileBrowserPane, { selectedTransferPaths } from './FileBrowserPane'
import RemotePathPicker from './RemotePathPicker'
import SftpPathField from './SftpPathField'
import { joinPath } from './utils'
import type { FileEntry } from './utils'

const LOCAL_PANE_HEIGHT_KEY = 'sftp.localPaneHeight'
const LOCAL_PANE_RATIO_KEY = 'sftp.localPaneRatio'
const LOCAL_PANE_OPEN_KEY = 'sftp.localPaneOpen'
const LOCAL_PANE_HEIGHT_DEFAULT = 200
const LOCAL_PANE_HEIGHT_MIN = 72
const REMOTE_PANE_MIN = 100

function clampLocalPaneHeight(height: number, bodyHeight: number): number {
  const max = Math.max(LOCAL_PANE_HEIGHT_MIN, bodyHeight - REMOTE_PANE_MIN)
  return Math.min(max, Math.max(LOCAL_PANE_HEIGHT_MIN, height))
}

function loadLocalPaneHeight(): number {
  try {
    const raw = localStorage.getItem(LOCAL_PANE_HEIGHT_KEY)
    if (raw != null) {
      const n = Number(raw)
      if (Number.isFinite(n) && n >= LOCAL_PANE_HEIGHT_MIN) return n
    }
    const ratioRaw =
      localStorage.getItem(LOCAL_PANE_RATIO_KEY) ?? localStorage.getItem('sftp.paneSplit')
    if (ratioRaw != null) {
      const ratio = Number(ratioRaw)
      if (Number.isFinite(ratio)) return Math.round(400 * ratio)
    }
  } catch {
    /* ignore */
  }
  return LOCAL_PANE_HEIGHT_DEFAULT
}

function loadLocalPaneOpen(): boolean {
  try {
    const raw = localStorage.getItem(LOCAL_PANE_OPEN_KEY)
    if (raw == null) return false
    return raw !== 'false'
  } catch {
    return false
  }
}

function persistLocalPaneHeight(height: number): void {
  try {
    localStorage.setItem(LOCAL_PANE_HEIGHT_KEY, String(Math.round(height)))
  } catch {
    /* ignore */
  }
}

function persistLocalPaneOpen(open: boolean): void {
  try {
    localStorage.setItem(LOCAL_PANE_OPEN_KEY, String(open))
  } catch {
    /* ignore */
  }
}

type SftpContextMenu = {
  pane: 'local' | 'remote'
  x: number
  y: number
  selectionCount: number
}

function transferOverallPercent(progress: SftpTransferProgress): number {
  if (progress.fileTotal <= 0) return 0
  const current =
    progress.fileIndex -
    1 +
    (progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : 1)
  return Math.min(100, Math.round((current / progress.fileTotal) * 100))
}

function TransferTitleProgress({
  label,
  progress
}: {
  label: string
  progress: SftpTransferProgress
}): JSX.Element {
  const percent = transferOverallPercent(progress)
  return (
    <span className="sftp-pane-title-progress">
      <span className="sftp-pane-title-progress-label">
        {label} {progress.fileIndex}/{progress.fileTotal} {percent}%
      </span>
      <span className="sftp-pane-title-progress-bar" aria-hidden>
        <span className="sftp-pane-title-progress-fill" style={{ width: `${percent}%` }} />
      </span>
    </span>
  )
}

export default function SftpPanel(): JSX.Element {
  const { panelWidth, setPanelWidth, setPanelOpen } = useSftpStore()
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const sessionId = activeTab && activeTab.status === 'connected' ? activeTab.sessionId : null
  const t = useT()

  const [localCwd, setLocalCwd] = useState('')
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [localSelected, setLocalSelected] = useState<Set<string>>(() => new Set())

  const [remoteCwd, setRemoteCwd] = useState('')
  const [remoteEntries, setRemoteEntries] = useState<SftpEntry[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(() => new Set())

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [splitResizing, setSplitResizing] = useState(false)
  const [localPaneHeight, setLocalPaneHeight] = useState(loadLocalPaneHeight)
  const [localPaneOpen, setLocalPaneOpen] = useState(loadLocalPaneOpen)
  const [menu, setMenu] = useState<SftpContextMenu | null>(null)
  const [remotePathPickerOpen, setRemotePathPickerOpen] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<SftpTransferProgress | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<SftpTransferProgress | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const uploadTransferId = useRef<string | null>(null)
  const downloadTransferId = useRef<string | null>(null)

  const loadLocal = useCallback(async (path: string): Promise<boolean> => {
    setLocalLoading(true)
    setError(null)
    const res = await window.api.local.list(path)
    if (res.error) {
      setError(res.error)
      setLocalLoading(false)
      return false
    }
    const resolved = res.cwd ?? path
    setLocalCwd(resolved)
    setLocalEntries(res.entries ?? [])
    setLocalSelected(new Set())
    setLocalLoading(false)
    return true
  }, [])

  const loadRemote = useCallback(
    async (path: string): Promise<boolean> => {
      if (!sessionId) return false
      setRemoteLoading(true)
      setError(null)
      const res = await window.api.sftp.list(sessionId, path)
      if (res.error) {
        setError(res.error)
        setRemoteLoading(false)
        return false
      }
      const resolved = res.cwd ?? path
      setRemoteCwd(resolved)
      setRemoteEntries(res.entries ?? [])
      setRemoteSelected(new Set())
      setRemoteLoading(false)
      return true
    },
    [sessionId]
  )

  useEffect(() => {
    void (async () => {
      const home = await window.api.local.home()
      if (home.path) void loadLocal(home.path)
      else void loadLocal('')
    })()
  }, [loadLocal])

  useEffect(() => {
    if (!sessionId) {
      setRemoteCwd('')
      setRemoteEntries([])
      setRemoteSelected(new Set())
      return
    }
    void loadRemote('.')
  }, [sessionId, loadRemote])

  useEffect(() => {
    const unsubProgress = window.api.sftp.onTransferProgress((event) => {
      if (event.transferId === uploadTransferId.current) {
        setUploadProgress(event)
      } else if (event.transferId === downloadTransferId.current) {
        setDownloadProgress(event)
      }
    })
    const unsubDone = window.api.sftp.onTransferDone((event) => {
      if (event.transferId === uploadTransferId.current) {
        uploadTransferId.current = null
        setUploadProgress(null)
      }
      if (event.transferId === downloadTransferId.current) {
        downloadTransferId.current = null
        setDownloadProgress(null)
      }
    })
    return () => {
      unsubProgress()
      unsubDone()
    }
  }, [])

  const refresh = (): void => {
    if (localCwd) void loadLocal(localCwd)
    if (sessionId && remoteCwd) void loadRemote(remoteCwd)
    else if (sessionId) void loadRemote('.')
  }

  const browseLocal = async (): Promise<void> => {
    const res = await window.api.local.pickDirectory(localCwd || undefined)
    if (res.path) void loadLocal(res.path)
    else if (res.error) setError(res.error)
  }

  const browseRemote = (): void => {
    if (!sessionId) return
    setRemotePathPickerOpen(true)
  }

  const onRemotePathPicked = (path: string): void => {
    setRemotePathPickerOpen(false)
    void loadRemote(path)
  }

  const closeLocalPane = (): void => {
    setLocalPaneOpen(false)
    persistLocalPaneOpen(false)
  }

  const openLocalPane = (): void => {
    setLocalPaneOpen(true)
    persistLocalPaneOpen(true)
    if (!localCwd) {
      void (async () => {
        const home = await window.api.local.home()
        if (home.path) void loadLocal(home.path)
        else void loadLocal('')
      })()
    }
  }

  const uploadFiles = async (paths: string[]): Promise<void> => {
    if (!sessionId || !remoteCwd || paths.length === 0) return
    const transferId = crypto.randomUUID()
    uploadTransferId.current = transferId
    setBusy(true)
    setError(null)
    setUploadProgress({ fileName: '', fileIndex: 0, fileTotal: 0, bytesDone: 0, bytesTotal: 0 })
    try {
      const res = await window.api.sftp.uploadPaths(sessionId, paths, remoteCwd, transferId)
      if (res.error && !res.count) setError(res.error)
      else if (res.errors?.length)
        setError(t('sftp.transferPartialError', { errors: res.errors.join('\n') }))
      void loadRemote(remoteCwd)
      setLocalSelected(new Set())
    } finally {
      if (uploadTransferId.current === transferId) {
        uploadTransferId.current = null
        setUploadProgress(null)
      }
      setBusy(false)
    }
  }

  const downloadFiles = async (paths: string[]): Promise<void> => {
    if (!sessionId || !localCwd || paths.length === 0) return
    const transferId = crypto.randomUUID()
    downloadTransferId.current = transferId
    setBusy(true)
    setError(null)
    setDownloadProgress({ fileName: '', fileIndex: 0, fileTotal: 0, bytesDone: 0, bytesTotal: 0 })
    try {
      const res = await window.api.sftp.downloadPaths(sessionId, paths, localCwd, transferId)
      if (res.error && !res.count) setError(res.error)
      else if (res.errors?.length)
        setError(t('sftp.transferPartialError', { errors: res.errors.join('\n') }))
      if (localPaneOpen) void loadLocal(localCwd)
      setRemoteSelected(new Set())
    } finally {
      if (downloadTransferId.current === transferId) {
        downloadTransferId.current = null
        setDownloadProgress(null)
      }
      setBusy(false)
    }
  }

  const uploadSelected = async (): Promise<void> => {
    await uploadFiles(selectedTransferPaths(localSelected, localEntries))
  }

  const downloadSelected = async (): Promise<void> => {
    await downloadFiles(selectedTransferPaths(remoteSelected, remoteEntries))
  }

  const uploadEntry = async (entry: FileEntry): Promise<void> => {
    await uploadFiles([entry.path])
  }

  const downloadEntry = async (entry: FileEntry): Promise<void> => {
    await downloadFiles([entry.path])
  }

  const renameRemote = async (entry: { name: string; path: string }): Promise<void> => {
    if (!sessionId || !remoteCwd) return
    const name = window.prompt(t('sftp.promptRename'), entry.name)
    if (!name || name === entry.name) return
    setBusy(true)
    const res = await window.api.sftp.rename(sessionId, entry.path, joinPath(remoteCwd, name))
    setBusy(false)
    if (res.error) setError(res.error)
    else void loadRemote(remoteCwd)
  }

  const removeRemote = async (entry: { name: string; path: string; type: string }): Promise<void> => {
    if (!sessionId) return
    const isDir = entry.type === 'dir'
    if (
      !window.confirm(
        t(isDir ? 'sftp.confirmDeleteDir' : 'sftp.confirmDeleteFile', { name: entry.name })
      )
    )
      return
    setBusy(true)
    const res = await window.api.sftp.delete(sessionId, entry.path, isDir)
    setBusy(false)
    if (res.error) setError(res.error)
    else if (remoteCwd) void loadRemote(remoteCwd)
  }

  const renameLocalEntry = async (entry: { name: string; path: string }): Promise<void> => {
    if (!localCwd) return
    const name = window.prompt(t('sftp.promptRename'), entry.name)
    if (!name || name === entry.name) return
    setBusy(true)
    const res = await window.api.local.rename(entry.path, joinPath(localCwd, name))
    setBusy(false)
    if (res.error) setError(res.error)
    else void loadLocal(localCwd)
  }

  const removeLocalEntry = async (entry: { name: string; path: string; type: string }): Promise<void> => {
    const isDir = entry.type === 'dir'
    if (
      !window.confirm(
        t(isDir ? 'sftp.confirmDeleteDir' : 'sftp.confirmDeleteFile', { name: entry.name })
      )
    )
      return
    setBusy(true)
    const res = await window.api.local.delete(entry.path, isDir)
    setBusy(false)
    if (res.error) setError(res.error)
    else if (localCwd) void loadLocal(localCwd)
  }

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidth
    setResizing(true)
    const onMove = (ev: MouseEvent): void => {
      setPanelWidth(startWidth + (startX - ev.clientX))
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

  const startSplitResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const bodyHeight = body.getBoundingClientRect().height
    const startY = e.clientY
    const startHeight = localPaneHeight
    setSplitResizing(true)
    const onMove = (ev: MouseEvent): void => {
      const h = body.getBoundingClientRect().height
      const delta = startY - ev.clientY
      const next = clampLocalPaneHeight(startHeight + delta, h)
      setLocalPaneHeight(next)
    }
    const onUp = (): void => {
      setSplitResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setLocalPaneHeight((h) => {
        const clamped = clampLocalPaneHeight(h, body.getBoundingClientRect().height || bodyHeight)
        persistLocalPaneHeight(clamped)
        return clamped
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  const resetLocalPaneHeight = (): void => {
    const bodyHeight = bodyRef.current?.getBoundingClientRect().height ?? 0
    const next = clampLocalPaneHeight(LOCAL_PANE_HEIGHT_DEFAULT, bodyHeight)
    setLocalPaneHeight(next)
    persistLocalPaneHeight(next)
  }

  useEffect(() => {
    if (!localPaneOpen || !bodyRef.current) return
    const clamp = (): void => {
      const bodyHeight = bodyRef.current?.getBoundingClientRect().height ?? 0
      if (bodyHeight <= 0) return
      setLocalPaneHeight((h) => {
        const next = clampLocalPaneHeight(h, bodyHeight)
        if (next !== h) persistLocalPaneHeight(next)
        return next
      })
    }
    const ro = new ResizeObserver(clamp)
    ro.observe(bodyRef.current)
    return () => ro.disconnect()
  }, [localPaneOpen])

  const onHandleKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') setPanelWidth(panelWidth + 24)
    else if (e.key === 'ArrowRight') setPanelWidth(panelWidth - 24)
  }

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('wheel', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('wheel', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const openRowContextMenu = (
    pane: 'local' | 'remote',
    entry: FileEntry,
    selected: Set<string>,
    entries: LocalEntry[] | SftpEntry[],
    onSelectedChange: (next: Set<string>) => void,
    e: React.MouseEvent
  ): void => {
    e.stopPropagation()
    const nextSelected = selected.has(entry.path) ? selected : new Set([entry.path])
    if (!selected.has(entry.path)) onSelectedChange(nextSelected)
    setMenu({
      pane,
      x: e.clientX,
      y: e.clientY,
      selectionCount: selectedTransferPaths(nextSelected, entries).length
    })
  }

  const canUploadFromMenu =
    !busy && !!sessionId && !!remoteCwd && localPaneOpen && (menu?.selectionCount ?? 0) > 0
  const canDownloadFromMenu = !busy && !!sessionId && !!localCwd && (menu?.selectionCount ?? 0) > 0

  return (
    <div className="side-panel" style={{ width: panelWidth }}>
      <div
        className={`panel-resizer ${resizing ? 'active' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sftp.resizeLabel')}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={clampPanelWidth(panelWidth)}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={onHandleKey}
        onDoubleClick={() => setPanelWidth(460)}
        data-tip={t('sftp.resizeTip')}
      />
      <div className="side-panel-header">
        <span className="panel-title">
          <span className="spark" />
          {t('sftp.title')}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="sftp-btn-icon sftp-btn-icon-refresh"
            onClick={refresh}
            title={t('sftp.refresh')}
            aria-label={t('sftp.refresh')}
          />
          <button
            className="sftp-btn-icon sftp-btn-icon-close"
            onClick={() => setPanelOpen(false)}
            title={t('sftp.hide')}
            aria-label={t('sftp.hide')}
          />
        </div>
      </div>

      {error && <div className="sftp-error">{error}</div>}

      <div className="sftp-body" ref={bodyRef}>
        <div className="sftp-pane-slot sftp-pane-slot-remote">
          {!sessionId ? (
            <div className="sftp-pane sftp-pane-empty">
              <div className="sftp-pane-title">
                <span>{t('sftp.remoteTitle')}</span>
              </div>
              <div className="chat-empty">
                {t('sftp.noSession')}
                <div style={{ marginTop: 10, color: 'var(--text-faint)' }}>
                  {t('sftp.noSessionHint')}
                </div>
              </div>
            </div>
          ) : (
            <FileBrowserPane
              title={t('sftp.remoteTitle')}
              cwd={remoteCwd}
              entries={remoteEntries}
              loading={remoteLoading}
              selected={remoteSelected}
              onSelectedChange={setRemoteSelected}
              onNavigate={(path) => void loadRemote(path)}
              onBrowse={browseRemote}
              titleProgress={
                downloadProgress ? (
                  <TransferTitleProgress label={t('sftp.download')} progress={downloadProgress} />
                ) : undefined
              }
              onRowContextMenu={(entry, e) =>
                openRowContextMenu('remote', entry, remoteSelected, remoteEntries, setRemoteSelected, e)
              }
              renderRowActions={(entry) => (
                <>
                  <button
                    className="sftp-act"
                    onClick={() => void downloadEntry(entry)}
                    disabled={busy || !localCwd}
                    title={t('sftp.download')}
                    aria-label={t('sftp.download')}
                  >
                    <UiIcon name="download" size="sm" />
                  </button>
                  <button
                    className="sftp-act"
                    onClick={() => void renameRemote(entry)}
                    disabled={busy}
                    title={t('sftp.rename')}
                    aria-label={t('sftp.rename')}
                  >
                    <UiIcon name="rename" size="sm" />
                  </button>
                  <button
                    className="sftp-act sftp-act--danger"
                    onClick={() => void removeRemote(entry)}
                    disabled={busy}
                    title={t('sftp.delete')}
                    aria-label={t('sftp.delete')}
                  >
                    <UiIcon name="delete" size="sm" />
                  </button>
                </>
              )}
            />
          )}
        </div>

        {localPaneOpen && (
          <div
            className="sftp-pane-slot sftp-pane-slot-local"
            style={{ height: localPaneHeight }}
          >
            <FileBrowserPane
              title={t('sftp.localTitle')}
              cwd={localCwd}
              entries={localEntries}
              loading={localLoading}
              selected={localSelected}
              onSelectedChange={setLocalSelected}
              onNavigate={(path) => void loadLocal(path)}
              onBrowse={() => void browseLocal()}
              titleProgress={
                uploadProgress ? (
                  <TransferTitleProgress label={t('sftp.upload')} progress={uploadProgress} />
                ) : undefined
              }
              onRowContextMenu={(entry, e) =>
                openRowContextMenu('local', entry, localSelected, localEntries, setLocalSelected, e)
              }
              titleResize={{
                resizing: splitResizing,
                tip: t('sftp.paneSplitTip'),
                onMouseDown: startSplitResize,
                onDoubleClick: resetLocalPaneHeight
              }}
              titleActions={
                <button
                  type="button"
                  className="sftp-pane-title-btn"
                  onClick={closeLocalPane}
                  title={t('sftp.hideLocal')}
                  aria-label={t('sftp.hideLocal')}
                >
                  ×
                </button>
              }
              renderRowActions={(entry) => (
                <>
                  <button
                    className="sftp-act"
                    onClick={() => void uploadEntry(entry)}
                    disabled={busy || !sessionId || !remoteCwd}
                    title={t('sftp.upload')}
                    aria-label={t('sftp.upload')}
                  >
                    <UiIcon name="upload" size="sm" />
                  </button>
                  <button
                    className="sftp-act"
                    onClick={() => void renameLocalEntry(entry)}
                    disabled={busy}
                    title={t('sftp.rename')}
                    aria-label={t('sftp.rename')}
                  >
                    <UiIcon name="rename" size="sm" />
                  </button>
                  <button
                    className="sftp-act sftp-act--danger"
                    onClick={() => void removeLocalEntry(entry)}
                    disabled={busy}
                    title={t('sftp.delete')}
                    aria-label={t('sftp.delete')}
                  >
                    <UiIcon name="delete" size="sm" />
                  </button>
                </>
              )}
            />
          </div>
        )}

        {!localPaneOpen && (
          <div className="sftp-local-collapsed">
            <button
              type="button"
              className="sftp-local-collapsed-toggle"
              onClick={openLocalPane}
              title={t('sftp.showLocal')}
              aria-label={t('sftp.showLocal')}
            >
              <span className="sftp-local-collapsed-chevron" aria-hidden />
              {t('sftp.showLocal')}
            </button>
            <div
              className="sftp-local-collapsed-toolbar"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <SftpPathField
                cwd={localCwd}
                onNavigate={(path) => void loadLocal(path)}
                onBrowse={() => void browseLocal()}
              />
            </div>
          </div>
        )}
      </div>

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.pane === 'local' && (
            <ContextMenuItem
              icon="upload"
              disabled={!canUploadFromMenu}
              onClick={() => {
                setMenu(null)
                void uploadSelected()
              }}
            >
              {t('sftp.upload')}
            </ContextMenuItem>
          )}
          {menu.pane === 'remote' && (
            <ContextMenuItem
              icon="download"
              disabled={!canDownloadFromMenu}
              onClick={() => {
                setMenu(null)
                void downloadSelected()
              }}
            >
              {t('sftp.download')}
            </ContextMenuItem>
          )}
        </div>
      )}

      {remotePathPickerOpen && sessionId && (
        <RemotePathPicker
          sessionId={sessionId}
          initialPath={remoteCwd || '.'}
          onSelect={onRemotePathPicked}
          onClose={() => setRemotePathPickerOpen(false)}
        />
      )}
    </div>
  )
}
