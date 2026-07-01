import { useEffect, useState } from 'react'
import { useUserRulesStore } from '../../store/userRulesStore'
import { useT } from '../../lib/i18n'

interface Props {
  onClose: () => void
}

export default function UserRulesModal({ onClose }: Props): JSX.Element {
  const t = useT()
  const rules = useUserRulesStore((s) => s.rules)
  const loaded = useUserRulesStore((s) => s.loaded)
  const load = useUserRulesStore((s) => s.load)
  const setRules = useUserRulesStore((s) => s.setRules)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (loaded) setDraft(rules)
  }, [loaded, rules])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await setRules(draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-user-rules" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('settings.userRules.title')}</div>
        <div className="modal-body">
          <div className="context-hint">{t('settings.userRules.hint')}</div>
          <textarea
            className="user-rules-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('settings.userRules.placeholder')}
            rows={12}
            disabled={!loaded}
          />
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" onClick={() => void handleSave()} disabled={!loaded || saving}>
            {saving ? t('common.save') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
