import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../lib/i18n'
import type { SftpEntry } from '../../../shared/types'
import { parentDir } from './utils'

interface Props {
  sessionId: string
  initialPath: string
  onSelect: (path: string) => void
  onClose: () => void
}

export default function RemotePathPicker({
  sessionId,
  initialPath,
  onSelect,
  onClose
}: Props): JSX.Element {
  const t = useT()
  const [cwd, setCwd] = useState(initialPath || '.')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(
    async (path: string): Promise<void> => {
      setLoading(true)
      setError(null)
      const res = await window.api.sftp.list(sessionId, path)
      if (res.error) {
        setError(res.error)
        setLoading(false)
        return
      }
      const resolved = res.cwd ?? path
      setCwd(resolved)
      setEntries(res.entries ?? [])
      setSelected(resolved)
      setLoading(false)
    },
    [sessionId]
  )

  useEffect(() => {
    void load(initialPath || '.')
  }, [initialPath, load])

  const dirs = entries.filter((e) => e.type === 'dir' || e.type === 'link')

  const enterDir = (entry: SftpEntry): void => {
    void load(entry.path)
  }

  const goUp = (): void => {
    if (cwd) void load(parentDir(cwd))
  }

  const confirm = (): void => {
    onSelect(selected ?? cwd)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sftp-path-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('sftp.pickRemotePath')}</div>
        <div className="modal-body">
          <div className="sftp-toolbar sftp-path-picker-toolbar">
            <button
              type="button"
              className="sftp-btn-icon sftp-btn-icon-up"
              onClick={goUp}
              disabled={!cwd || loading}
              title={t('sftp.up')}
              aria-label={t('sftp.up')}
            />
            <div className="sftp-path">
              <span className="sftp-path-picker-cwd" title={cwd}>
                {cwd}
              </span>
            </div>
          </div>
          {error && <div className="sftp-error">{error}</div>}
          <div className="sftp-path-picker-list">
            {loading ? (
              <div className="sftp-empty">{t('sftp.loading')}</div>
            ) : dirs.length === 0 ? (
              <div className="sftp-empty">{t('sftp.emptyDir')}</div>
            ) : (
              dirs.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={`sftp-path-picker-row ${selected === entry.path ? 'selected' : ''}`}
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() => enterDir(entry)}
                  title={entry.path}
                >
                  <span className="sftp-entry-icon dir" aria-hidden />
                  <span className="sftp-name">{entry.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary" onClick={confirm} disabled={loading || !cwd}>
            {t('sftp.selectPath')}
          </button>
        </div>
      </div>
    </div>
  )
}
