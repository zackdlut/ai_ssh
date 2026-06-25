import { useEffect, useState } from 'react'
import type { AISettings } from '../../../shared/types'

interface Props {
  onClose: () => void
}

export default function SettingsModal({ onClose }: Props): JSX.Element {
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void window.api.config.getAISettings().then((s: AISettings) => {
      setBaseURL(s.baseURL)
      setApiKey(s.apiKey)
      setModel(s.model)
      setLoaded(true)
    })
  }, [])

  const handleSave = async (): Promise<void> => {
    await window.api.config.setAISettings({ baseURL, apiKey, model })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">AI Settings</div>
        <div className="modal-body">
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
            <label>Model</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
          </div>
          <div className="context-hint">
            Works with OpenAI, DeepSeek, local vLLM/Ollama and other OpenAI-compatible endpoints. The
            key is stored locally and only used by the main process.
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
