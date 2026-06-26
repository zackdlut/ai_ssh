import { useCallback, useEffect, useRef, useState } from 'react'
import { clampPanelWidth, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '../../store/aiStore'
import { useSftpStore } from '../../store/sftpStore'
import { useTabsStore } from '../../store/tabsStore'
import { useT } from '../../lib/i18n'
import type { SftpEntry } from '../../../shared/types'

function parentDir(path: string): string {
  if (path === '/' || !path) return '/'
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

function joinPath(dir: string, name: string): string {
  return `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${name}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function SftpPanel(): JSX.Element {
  const { panelWidth, setPanelWidth, setPanelOpen } = useSftpStore()
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const sessionId = activeTab && activeTab.status === 'connected' ? activeTab.sessionId : null
  const t = useT()

  const [cwd, setCwd] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resizing, setResizing] = useState(false)

  const load = useCallback(
    async (path: string): Promise<boolean> => {
      if (!sessionId) return false
      setLoading(true)
      setError(null)
      const res = await window.api.sftp.list(sessionId, path)
      if (res.error) {
        setError(res.error)
        setLoading(false)
        return false
      }
      const resolved = res.cwd ?? path
      setCwd(resolved)
      setPathInput(resolved)
      setEntries(res.entries ?? [])
      setLoading(false)
      return true
    },
    [sessionId]
  )

  useEffect(() => {
    setPathInput(cwd)
  }, [cwd])

  // Open the home directory whenever the bound session changes.
  useEffect(() => {
    if (!sessionId) {
      setCwd('')
      setPathInput('')
      setEntries([])
      setError(null)
      return
    }
    void load('.')
  }, [sessionId, load])

  const refresh = (): void => {
    if (cwd) void load(cwd)
  }

  const enter = (entry: SftpEntry): void => {
    if (entry.type === 'dir' || entry.type === 'link') void load(entry.path)
  }

  const goUp = (): void => {
    if (cwd) void load(parentDir(cwd))
  }

  const submitPath = (): void => {
    const path = pathInput.trim()
    if (!path) return
    void load(path)
  }

  const onPathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      submitPath()
    } else if (e.key === 'Escape') {
      setPathInput(cwd)
      e.currentTarget.blur()
    }
  }

  const download = async (entry: SftpEntry): Promise<void> => {
    if (!sessionId) return
    setBusy(true)
    const res = await window.api.sftp.download(sessionId, entry.path)
    setBusy(false)
    if (res.error) setError(res.error)
  }

  const upload = async (): Promise<void> => {
    if (!sessionId || !cwd) return
    setBusy(true)
    const res = await window.api.sftp.upload(sessionId, cwd)
    setBusy(false)
    if (res.error) setError(res.error)
    else if (!res.cancelled) void load(cwd)
  }

  const newFolder = async (): Promise<void> => {
    if (!sessionId || !cwd) return
    const name = window.prompt(t('sftp.promptNewFolder'))
    if (!name) return
    setBusy(true)
    const res = await window.api.sftp.mkdir(sessionId, joinPath(cwd, name))
    setBusy(false)
    if (res.error) setError(res.error)
    else void load(cwd)
  }

  const rename = async (entry: SftpEntry): Promise<void> => {
    if (!sessionId || !cwd) return
    const name = window.prompt(t('sftp.promptRename'), entry.name)
    if (!name || name === entry.name) return
    setBusy(true)
    const res = await window.api.sftp.rename(sessionId, entry.path, joinPath(cwd, name))
    setBusy(false)
    if (res.error) setError(res.error)
    else void load(cwd)
  }

  const remove = async (entry: SftpEntry): Promise<void> => {
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
    else if (cwd) void load(cwd)
  }

  // Drag the left edge to resize. Dragging left widens the panel.
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

  const onHandleKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') setPanelWidth(panelWidth + 24)
    else if (e.key === 'ArrowRight') setPanelWidth(panelWidth - 24)
  }

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
            disabled={!sessionId}
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

      {!sessionId ? (
        <div className="chat-empty">
          {t('sftp.noSession')}
          <div style={{ marginTop: 10, color: 'var(--text-faint)' }}>{t('sftp.noSessionHint')}</div>
        </div>
      ) : (
        <>
          <div className="sftp-toolbar">
            <button
              className="sftp-btn-icon sftp-btn-icon-up"
              onClick={goUp}
              title={t('sftp.up')}
              aria-label={t('sftp.up')}
            />
            <div className="sftp-path">
              <input
                className="sftp-path-input"
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={onPathKeyDown}
                onBlur={() => setPathInput(cwd)}
                spellCheck={false}
                autoComplete="off"
                aria-label={t('sftp.path')}
                placeholder="/"
              />
            </div>
            <div className="sftp-toolbar-actions">
              <button className="sftp-btn-text" onClick={newFolder} disabled={busy} title={t('sftp.newFolder')}>
                {t('sftp.new')}
              </button>
              <button className="sftp-btn-text" onClick={upload} disabled={busy} title={t('sftp.upload')}>
                {t('sftp.uploadBtn')}
              </button>
            </div>
          </div>

          {error && <div className="sftp-error">{error}</div>}

          <div className="sftp-list">
            {!loading && entries.length > 0 && (
              <div className="sftp-list-head" aria-hidden>
                <span className="sftp-col-icon" />
                <span className="sftp-col-name">{t('sftp.name')}</span>
                <span className="sftp-col-size">{t('sftp.size')}</span>
                <span className="sftp-col-time">{t('sftp.modified')}</span>
                <span className="sftp-col-actions" />
              </div>
            )}
            {loading ? (
              <div className="sftp-empty">{t('sftp.loading')}</div>
            ) : entries.length === 0 ? (
              <div className="sftp-empty">{t('sftp.emptyDir')}</div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.path}
                  className={`sftp-row ${entry.type}`}
                  onDoubleClick={() => enter(entry)}
                >
                  <span className={`sftp-entry-icon ${entry.type}`} aria-hidden />
                  <span className="sftp-name" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="sftp-size">{entry.type === 'dir' ? '' : formatSize(entry.size)}</span>
                  <span className="sftp-time">{formatTime(entry.mtime)}</span>
                  <span className="sftp-actions">
                    {entry.type !== 'dir' && (
                      <button
                        className="sftp-act sftp-act-download"
                        onClick={() => download(entry)}
                        disabled={busy}
                        title={t('sftp.download')}
                        aria-label={t('sftp.download')}
                      />
                    )}
                    <button
                      className="sftp-act sftp-act-rename"
                      onClick={() => rename(entry)}
                      disabled={busy}
                      title={t('sftp.rename')}
                      aria-label={t('sftp.rename')}
                    />
                    <button
                      className="sftp-act sftp-act-delete"
                      onClick={() => remove(entry)}
                      disabled={busy}
                      title={t('sftp.delete')}
                      aria-label={t('sftp.delete')}
                    />
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
