import { useThemeStore } from '../../store/themeStore'
import { THEME_OPTIONS } from '../../lib/themes'
import { themeMeta, useT } from '../../lib/i18n'
import { useLocaleStore } from '../../store/localeStore'
import { ThemePreview } from '../settings/shared'
import type { AppTheme } from '../../../shared/types'
import type { ThemeMeta } from '../../lib/themes'

interface Props {
  onClose: () => void
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
