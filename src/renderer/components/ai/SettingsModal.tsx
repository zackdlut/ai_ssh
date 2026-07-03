import { useEffect, useState } from 'react'
import {
  DEFAULT_API_KEYS,
  DEFAULT_BASE_URLS,
  DEFAULT_CONTEXT_LENGTHS,
  DEFAULT_MODELS,
  MODEL_PROFILES,
  normalizeAISettings
} from '../../../shared/aiSettings'
import type { AISettings, ModelProfile } from '../../../shared/types'
import { modelProfileLabel, useT } from '../../lib/i18n'
import { useLocaleStore } from '../../store/localeStore'

interface Props {
  onClose: () => void
}

export default function SettingsModal({ onClose }: Props): JSX.Element {
  const t = useT()
  const [baseURLs, setBaseURLs] = useState<Record<ModelProfile, string>>({ ...DEFAULT_BASE_URLS })
  const [apiKeys, setApiKeys] = useState<Record<ModelProfile, string>>({ ...DEFAULT_API_KEYS })
  const [editingProfile, setEditingProfile] = useState<ModelProfile>('default')
  const [copilotModelProfile, setCopilotModelProfile] = useState<ModelProfile>('default')
  const [nlModelProfile, setNlModelProfile] = useState<ModelProfile>('fast')
  const [models, setModels] = useState<Record<ModelProfile, string>>({ ...DEFAULT_MODELS })
  const [contextLengths, setContextLengths] = useState<Record<ModelProfile, number>>({
    ...DEFAULT_CONTEXT_LENGTHS
  })
  const [httpProxy, setHttpProxy] = useState('')
  const [loaded, setLoaded] = useState(false)
  const locale = useLocaleStore((s) => s.locale)

  useEffect(() => {
    void window.api.config.getAISettings().then((s: AISettings) => {
      const normalized = normalizeAISettings(s)
      setBaseURLs({ ...normalized.baseURLs })
      setApiKeys({ ...normalized.apiKeys })
      setCopilotModelProfile(normalized.copilotModelProfile)
      setNlModelProfile(normalized.nlModelProfile)
      setModels({ ...normalized.models })
      setContextLengths({ ...normalized.contextLengths })
      setHttpProxy(normalized.httpProxy)
      setLoaded(true)
    })
  }, [])

  const editingProfileLabel = modelProfileLabel(locale, editingProfile)

  const updateModel = (profile: ModelProfile, value: string): void => {
    setModels((prev) => ({ ...prev, [profile]: value }))
  }

  const updateContextLength = (profile: ModelProfile, value: string): void => {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed)) return
    setContextLengths((prev) => ({ ...prev, [profile]: parsed }))
  }

  const updateBaseURL = (profile: ModelProfile, value: string): void => {
    setBaseURLs((prev) => ({ ...prev, [profile]: value }))
  }

  const updateApiKey = (profile: ModelProfile, value: string): void => {
    setApiKeys((prev) => ({ ...prev, [profile]: value }))
  }

  const handleSave = async (): Promise<void> => {
    const current = normalizeAISettings(await window.api.config.getAISettings())
    await window.api.config.setAISettings({
      ...current,
      baseURLs: { ...baseURLs },
      apiKeys: { ...apiKeys },
      copilotModelProfile,
      nlModelProfile,
      models: { ...models },
      contextLengths: { ...contextLengths },
      httpProxy
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
            <label>{t('settings.ai.contextLength', { profile: editingProfileLabel })}</label>
            <input
              key={`ctx-${editingProfile}`}
              type="number"
              min={1024}
              step={1024}
              value={contextLengths[editingProfile]}
              onChange={(e) => updateContextLength(editingProfile, e.target.value)}
              placeholder="32768"
            />
          </div>
          <div className="field">
            <label>{t('settings.ai.baseUrl', { profile: editingProfileLabel })}</label>
            <input
              key={`base-${editingProfile}`}
              value={baseURLs[editingProfile]}
              onChange={(e) => updateBaseURL(editingProfile, e.target.value)}
              placeholder={
                editingProfile === 'default'
                  ? 'https://api.openai.com/v1'
                  : t('settings.ai.inheritDefault')
              }
            />
          </div>
          <div className="field">
            <label>{t('settings.ai.apiKey', { profile: editingProfileLabel })}</label>
            <input
              key={`key-${editingProfile}`}
              type="password"
              value={apiKeys[editingProfile]}
              onChange={(e) => updateApiKey(editingProfile, e.target.value)}
              placeholder={editingProfile === 'default' ? 'sk-...' : t('settings.ai.inheritDefault')}
            />
          </div>
          <div className="field">
            <label>{t('settings.ai.httpProxy')}</label>
            <input
              value={httpProxy}
              onChange={(e) => setHttpProxy(e.target.value)}
              placeholder="http://127.0.0.1:7890"
            />
            <div className="context-hint">{t('settings.ai.httpProxyHint')}</div>
          </div>
          <div className="field">
            <label>{t('settings.ai.copilotModel')}</label>
            <div className="seg seg-profile">
              {MODEL_PROFILES.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={copilotModelProfile === profile.id ? 'active' : ''}
                  onClick={() => setCopilotModelProfile(profile.id)}
                >
                  {modelProfileLabel(locale, profile.id)}
                </button>
              ))}
            </div>
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
