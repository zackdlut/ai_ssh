import { useThemeStore } from '../../store/themeStore'
import { THEME_OPTIONS, type ThemeMeta } from '../../lib/themes'
import type { AppTheme } from '../../../shared/types'

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

  const select = (id: AppTheme): void => {
    void setTheme(id)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-themes" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Themes</div>
        <div className="modal-body">
          <p className="themes-lead">选择界面配色。切换后立即生效，并会保存到本地配置。</p>
          <div className="theme-grid">
            {THEME_OPTIONS.map((meta) => (
              <button
                key={meta.id}
                type="button"
                className={`theme-card ${theme === meta.id ? 'active' : ''}`}
                onClick={() => select(meta.id)}
                aria-pressed={theme === meta.id}
              >
                <ThemePreview meta={meta} />
                <div className="theme-card-copy">
                  <span className="theme-card-name">{meta.label}</span>
                  <span className="theme-card-desc">{meta.description}</span>
                </div>
                {theme === meta.id && <span className="theme-card-check">当前</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
