import { useEffect, useState } from 'react'
import { useSkillsStore } from '../../store/skillsStore'
import { useT } from '../../lib/i18n'

interface Props {
  onClose: () => void
}

export default function SkillsModal({ onClose }: Props): JSX.Element {
  const t = useT()
  const skills = useSkillsStore((s) => s.skills)
  const installing = useSkillsStore((s) => s.installing)
  const load = useSkillsStore((s) => s.load)
  const install = useSkillsStore((s) => s.install)
  const remove = useSkillsStore((s) => s.remove)
  const setEnabled = useSkillsStore((s) => s.setEnabled)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const handleInstall = async (): Promise<void> => {
    setError(null)
    const res = await install()
    if (res.error) setError(res.error)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('settings.skills.title')}</div>
        <div className="modal-body">
          <div className="context-hint">{t('settings.skills.hint')}</div>

          {skills.length === 0 ? (
            <div className="skills-empty">{t('settings.skills.empty')}</div>
          ) : (
            <div className="skills-list">
              {skills.map((skill) => (
                <div key={skill.id} className="skills-item">
                  <label className="skills-item-toggle">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={(e) => void setEnabled(skill.id, e.target.checked)}
                    />
                  </label>
                  <div className="skills-item-body">
                    <div className="skills-item-name">{skill.name}</div>
                    <div className="skills-item-desc">
                      {skill.description || t('settings.skills.noDescription')}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="skills-item-remove"
                    onClick={() => void remove(skill.id)}
                    title={t('settings.skills.remove')}
                    aria-label={t('settings.skills.remove')}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && <div className="skills-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
          <button className="primary" onClick={() => void handleInstall()} disabled={installing}>
            {installing ? t('settings.skills.installing') : t('settings.skills.install')}
          </button>
        </div>
      </div>
    </div>
  )
}
