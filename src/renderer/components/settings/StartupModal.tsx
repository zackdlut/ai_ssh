import { useStartupStore } from '../../store/startupStore'
import { useT } from '../../lib/i18n'
import { SettingRow } from './shared'

interface Props {
  onClose: () => void
}

export default function StartupModal({ onClose }: Props): JSX.Element {
  const connSidebarOpen = useStartupStore((s) => s.connSidebarOpen)
  const copilotOpen = useStartupStore((s) => s.copilotOpen)
  const setConnSidebarOpen = useStartupStore((s) => s.setConnSidebarOpen)
  const setCopilotOpen = useStartupStore((s) => s.setCopilotOpen)
  const t = useT()

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-startup" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('startup.title')}</div>
        <div className="modal-body">
          <p className="themes-lead">{t('startup.lead')}</p>
          <SettingRow
            label={t('startup.connSidebar')}
            hint={t('startup.connSidebarHint')}
          >
            <label className="startup-switch">
              <input
                type="checkbox"
                checked={connSidebarOpen}
                onChange={(e) => setConnSidebarOpen(e.target.checked)}
              />
              <span className="startup-switch-track" aria-hidden>
                <span className="startup-switch-thumb" />
              </span>
              <span className="startup-switch-text">
                {connSidebarOpen ? t('startup.on') : t('startup.off')}
              </span>
            </label>
          </SettingRow>
          <SettingRow label={t('startup.copilot')} hint={t('startup.copilotHint')}>
            <label className="startup-switch">
              <input
                type="checkbox"
                checked={copilotOpen}
                onChange={(e) => setCopilotOpen(e.target.checked)}
              />
              <span className="startup-switch-track" aria-hidden>
                <span className="startup-switch-thumb" />
              </span>
              <span className="startup-switch-text">
                {copilotOpen ? t('startup.on') : t('startup.off')}
              </span>
            </label>
          </SettingRow>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
