import { useEffect, useState } from 'react'
import { useT } from '../../lib/i18n'
import type { AppInfo } from '../../../shared/types'

interface Props {
  onClose: () => void
}

export default function AboutModal({ onClose }: Props): JSX.Element {
  const t = useT()
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.api.app.getInfo().then(setInfo)
  }, [])

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
          {info && (
            <dl className="about-meta">
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
            </dl>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
