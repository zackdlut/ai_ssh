import { useEffect, useState } from 'react'
import { DEFAULT_MODELS, MODEL_PROFILES, normalizeAISettings } from '../../../shared/aiSettings'
import type { AISettings, ModelProfile } from '../../../shared/types'

interface Props {
  onClose: () => void
}

export default function SettingsModal({ onClose }: Props): JSX.Element {
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [editingProfile, setEditingProfile] = useState<ModelProfile>('default')
  const [nlModelProfile, setNlModelProfile] = useState<ModelProfile>('fast')
  const [models, setModels] = useState<Record<ModelProfile, string>>({ ...DEFAULT_MODELS })
  const [loaded, setLoaded] = useState(false)

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

  const editingProfileLabel =
    MODEL_PROFILES.find((p) => p.id === editingProfile)?.label ?? editingProfile

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
        <div className="modal-header">AI Settings</div>
        <div className="modal-body">
          <div className="field">
            <label>Edit Profile</label>
            <div className="seg seg-profile">
              {MODEL_PROFILES.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={editingProfile === profile.id ? 'active' : ''}
                  onClick={() => setEditingProfile(profile.id)}
                >
                  {profile.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Model ({editingProfileLabel})</label>
            <input
              key={editingProfile}
              value={models[editingProfile]}
              onChange={(e) => updateModel(editingProfile, e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </div>
          <div className="field">
            <label>Base URL (OpenAI-compatible)</label>
            <input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div className="field">
            <label>Terminal AI Mode Model</label>
            <div className="seg seg-profile">
              {MODEL_PROFILES.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={nlModelProfile === profile.id ? 'active' : ''}
                  onClick={() => setNlModelProfile(profile.id)}
                >
                  {profile.label}
                </button>
              ))}
            </div>
          </div>
          <div className="context-hint">
            Works with OpenAI, DeepSeek, local vLLM/Ollama and other OpenAI-compatible endpoints. The
            key is stored locally and only used by the main process. Each profile can use a different
            model. Switch the Copilot model tier from the sidebar dropdown; configure the terminal
            AI mode model tier here (default: Fast).
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={handleSave} disabled={!loaded}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
