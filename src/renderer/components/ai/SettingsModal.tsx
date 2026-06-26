import { useEffect, useState } from 'react'
import { DEFAULT_MODELS, MODEL_PROFILES, normalizeAISettings } from '../../../shared/aiSettings'
import type { AISettings, ModelProfile } from '../../../shared/types'
import { modelProfileLabel, useT } from '../../lib/i18n'
import { useLocaleStore } from '../../store/localeStore'

interface Props {
  onClose: () => void
}

export default function SettingsModal({ onClose }: Props): JSX.Element {
  const t = useT()
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [editingProfile, setEditingProfile] = useState<ModelProfile>('default')
  const [nlModelProfile, setNlModelProfile] = useState<ModelProfile>('fast')
  const [models, setModels] = useState<Record<ModelProfile, string>>({ ...DEFAULT_MODELS })
  const [loaded, setLoaded] = useState(false)
  const locale = useLocaleStore((s) => s.locale)

  useEffect(() => {
    void window.api.config.getAISettings().then((s: AISettings) => {
      const normalized = normalizeAISettings(s)
      setBaseURL(normalized.baseURL)
      setApiKey(normalized.apiKey)
      setNlModelProfile(normalized.nlModelProfile)
      setModels({ ...normalized.models })
      setLoaded(true)
    })
  }, [])

  const editingProfileLabel = modelProfileLabel(locale, editingProfile)

  const updateModel = (profile: ModelProfile, value: string): void => {
    setModels((prev) => ({ ...prev, [profile]: value }))
  }

  const handleSave = async (): Promise<void> => {
    const current = normalizeAISettings(await window.api.config.getAISettings())
    await window.api.config.setAISettings({
      ...current,
      baseURL,
      apiKey,
      nlModelProfile,
      models: { ...models }
    })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('settings.ai.title')}</div>
        <div className="modal-body">
          <div className="field">
            <label>{t('settings.ai.editProfile')}</label>
            <div className="seg seg-profile">
              {MODEL_PROFILES.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={editingProfile === profile.id ? 'active' : ''}
                  onClick={() => setEditingProfile(profile.id)}
                >
                  {modelProfileLabel(locale, profile.id)}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>{t('settings.ai.model', { profile: editingProfileLabel })}</label>
            <input
              key={editingProfile}
              value={models[editingProfile]}
              onChange={(e) => updateModel(editingProfile, e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </div>
          <div className="field">
            <label>{t('settings.ai.baseUrl')}</label>
            <input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div className="field">
            <label>{t('settings.ai.apiKey')}</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div className="field">
            <label>{t('settings.ai.nlModel')}</label>
            <div className="seg seg-profile">
              {MODEL_PROFILES.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={nlModelProfile === profile.id ? 'active' : ''}
                  onClick={() => setNlModelProfile(profile.id)}
                >
                  {modelProfileLabel(locale, profile.id)}
                </button>
              ))}
            </div>
          </div>
          <div className="context-hint">{t('settings.ai.hint')}</div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" onClick={handleSave} disabled={!loaded}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
