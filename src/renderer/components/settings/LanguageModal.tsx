import { useLocaleStore } from '../../store/localeStore'
import { useT } from '../../lib/i18n'
import type { AppLocale } from '../../../shared/types'

interface Props {
  onClose: () => void
}

const OPTIONS: { id: AppLocale; labelKey: 'language.zh' | 'language.en'; descKey: 'language.zhDesc' | 'language.enDesc' }[] = [
  { id: 'zh', labelKey: 'language.zh', descKey: 'language.zhDesc' },
  { id: 'en', labelKey: 'language.en', descKey: 'language.enDesc' }
]

export default function LanguageModal({ onClose }: Props): JSX.Element {
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)
  const t = useT()

  const select = (id: AppLocale): void => {
    void setLocale(id)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-language" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('language.title')}</div>
        <div className="modal-body">
          <p className="themes-lead">{t('language.lead')}</p>
          <div className="language-grid">
            {OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`language-card ${locale === opt.id ? 'active' : ''}`}
                onClick={() => select(opt.id)}
                aria-pressed={locale === opt.id}
              >
                <span className="language-card-glyph" aria-hidden>
                  {opt.id === 'zh' ? '中' : 'En'}
                </span>
                <div className="language-card-copy">
                  <span className="language-card-name">{t(opt.labelKey)}</span>
                  <span className="language-card-desc">{t(opt.descKey)}</span>
                </div>
                {locale === opt.id && <span className="theme-card-check">{t('language.current')}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
