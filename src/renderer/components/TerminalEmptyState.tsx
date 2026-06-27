import { useMemo, useState } from 'react'
import { useBookmarksStore } from '../store/bookmarksStore'
import { connectFromConfig } from '../lib/connect'
import { useT } from '../lib/i18n'
import type { ConnectionConfig } from '../../shared/types'

interface Props {
  onNewConnection: () => void
}

function connMeta(c: ConnectionConfig): string {
  const port = c.port || 22
  const base = `${c.username}@${c.host}`
  return port === 22 ? base : `${base}:${port}`
}

/** Compact primary + optional host suffix for single-line capsules. */
function connCapsuleText(c: ConnectionConfig): { primary: string; suffix?: string } {
  const meta = connMeta(c)
  const name = c.name?.trim()
  if (name && name !== meta) return { primary: name, suffix: meta }
  return { primary: meta }
}

export default function TerminalEmptyState({ onNewConnection }: Props): JSX.Element {
  const connections = useBookmarksStore((s) => s.connections)
  const getRecentConnections = useBookmarksStore((s) => s.getRecentConnections)
  const t = useT()
  const [connectingId, setConnectingId] = useState<string | null>(null)

  const recent = useMemo(
    () => getRecentConnections(10, true),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when saved connections change
    [connections, getRecentConnections]
  )

  const handleConnect = async (c: ConnectionConfig): Promise<void> => {
    if (connectingId) return
    setConnectingId(c.id)
    const err = await connectFromConfig(c)
    if (err) window.alert(err)
    setConnectingId(null)
  }

  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden>
        ⌁
      </div>
      <div>
        <div className="empty-title">{t('app.emptyTitle')}</div>
        <div className="empty-sub">{t('app.emptySub')}</div>
      </div>
      <button className="primary" onClick={onNewConnection}>
        {t('app.newConnection')}
      </button>

      {recent.length > 0 && (
        <div className="empty-recent" role="region" aria-label={t('app.recentConnections')}>
          <div className="empty-recent-label">{t('app.recentConnections')}</div>
          <div className="conn-capsule-grid">
            {recent.map((c, i) => {
              const busy = connectingId === c.id
              const disabled = Boolean(connectingId)
              const { primary, suffix } = connCapsuleText(c)
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`conn-capsule${busy ? ' connecting' : ''}`}
                  style={{ animationDelay: `${60 + i * 40}ms` }}
                  onClick={() => void handleConnect(c)}
                  disabled={disabled}
                  title={connMeta(c)}
                >
                  <span className="conn-capsule-signal" aria-hidden />
                  <span className="conn-capsule-text">
                    <span className="conn-capsule-label">{primary}</span>
                    {suffix && (
                      <>
                        <span className="conn-capsule-sep" aria-hidden>
                          ·
                        </span>
                        <span className="conn-capsule-host">{suffix}</span>
                      </>
                    )}
                  </span>
                  {busy && <span className="conn-capsule-spinner" aria-hidden />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
