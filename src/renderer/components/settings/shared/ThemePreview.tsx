import type { ThemeMeta } from '../../../lib/themes'

export default function ThemePreview({ meta }: { meta: ThemeMeta }): JSX.Element {
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
