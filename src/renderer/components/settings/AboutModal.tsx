import { useEffect, useState } from 'react'
import { useT } from '../../lib/i18n'
import type { AppInfo } from '../../../shared/types'

interface Props {
  onClose: () => void
}

export default function AboutModal({ onClose }: Props): JSX.Element {
  const t = useT()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [debugLogEnabled, setDebugLogEnabled] = useState(false)

  useEffect(() => {
    void Promise.all([window.api.app.getInfo(), window.api.debug.getSettings()]).then(
      ([appInfo, debug]) => {
        setInfo(appInfo)
        setDebugLogEnabled(debug.enabled)
      }
    )
  }, [])

  const toggleDebugLog = (enabled: boolean): void => {
    setDebugLogEnabled(enabled)
    void window.api.debug.setEnabled(enabled)
  }

  const debugLogFilePath = info
    ? `${info.debugLogDir}/debug-${new Date().toISOString().slice(0, 10)}.log`
    : ''

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-about" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('about.title')}</div>
        <div className="modal-body about-body">
          <div className="about-brand">
            <span className="about-mark" aria-hidden>
              ⌁
            </span>
            <div>
              <div className="about-name">{info?.name ?? 'AI Terminal'}</div>
              <div className="about-version">
                {info ? t('about.version', { version: info.version }) : '…'}
              </div>
            </div>
          </div>
          <p className="about-desc">{t('about.description')}</p>
          <dl className="about-meta">
            {info && (
              <>
                <div>
                  <dt>{t('about.author')}</dt>
                  <dd>{info.author}</dd>
                </div>
                <div>
                  <dt>{t('about.email')}</dt>
                  <dd>
                    <a className="about-email-link" href={`mailto:${info.email}`}>
                      {info.email}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>{t('about.electron')}</dt>
                  <dd>{info.electron}</dd>
                </div>
                <div>
                  <dt>{t('about.license')}</dt>
                  <dd>{info.license}</dd>
                </div>
              </>
            )}
            <div>
              <dt>{t('settings.debugLog.enabled')}</dt>
              <dd>
                <div className="about-meta-switch-wrap">
                  <label className="startup-switch about-meta-switch">
                    <input
                      type="checkbox"
                      checked={debugLogEnabled}
                      onChange={(e) => toggleDebugLog(e.target.checked)}
                      aria-label={t('settings.debugLog.enabled')}
                    />
                    <span className="startup-switch-track" aria-hidden>
                      <span className="startup-switch-thumb" />
                    </span>
                  </label>
                  {debugLogEnabled && debugLogFilePath && (
                    <p className="about-debug-log-hint">{debugLogFilePath}</p>
                  )}
                </div>
              </dd>
            </div>
          </dl>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
