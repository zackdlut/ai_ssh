import { useThemeStore } from '../../store/themeStore'
import { THEME_OPTIONS } from '../../lib/themes'
import { themeMeta, useT } from '../../lib/i18n'
import { useLocaleStore } from '../../store/localeStore'
import type { AppTheme } from '../../../shared/types'
import type { ThemeMeta } from '../../lib/themes'

interface Props {
  onClose: () => void
}

function ThemePreview({ meta }: { meta: ThemeMeta }): JSX.Element {
  const isDawn = meta.id === 'dawn'
  return (
    <div className={`theme-preview ${isDawn ? 'theme-preview-dawn' : 'theme-preview-aurora'}`}>
      <div className="theme-preview-chrome">
        <span className="theme-preview-dot" />
        <span className="theme-preview-dot" />
        <span className="theme-preview-dot accent" />
      </div>
      <div className="theme-preview-body">
        <div className="theme-preview-line accent" />
        <div className="theme-preview-line" />
        <div className="theme-preview-line short" />
        <div className="theme-preview-prompt">
          <span className="theme-preview-cursor" />
        </div>
      </div>
      <span className="theme-preview-tag">{meta.tag}</span>
    </div>
  )
}

export default function ThemesModal({ onClose }: Props): JSX.Element {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const locale = useLocaleStore((s) => s.locale)
  const t = useT()

  const select = (id: AppTheme): void => {
    void setTheme(id)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-themes" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('themes.title')}</div>
        <div className="modal-body">
          <p className="themes-lead">{t('themes.lead')}</p>
          <div className="theme-grid">
            {THEME_OPTIONS.map((opt) => {
              const meta = themeMeta(locale, opt.id)
              const previewMeta: ThemeMeta = { id: opt.id, ...meta }
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`theme-card ${theme === opt.id ? 'active' : ''}`}
                  onClick={() => select(opt.id)}
                  aria-pressed={theme === opt.id}
                >
                  <ThemePreview meta={previewMeta} />
                  <div className="theme-card-copy">
                    <span className="theme-card-name">{meta.label}</span>
                    <span className="theme-card-desc">{meta.description}</span>
                  </div>
                  {theme === opt.id && <span className="theme-card-check">{t('themes.current')}</span>}
                </button>
              )
            })}
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
