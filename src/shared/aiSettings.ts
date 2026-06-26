import type { AISettings, ModelProfile } from './types'

export const MODEL_PROFILES: { id: ModelProfile; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'fast', label: 'Fast' },
  { id: 'medium', label: 'Med' },
  { id: 'high', label: 'High' },
  { id: 'custom', label: 'Custom' }
]

const FALLBACK_MODEL = 'gpt-4o-mini'
const DEFAULT_STORE_MODEL = 'qwen3.5:9b'

/** Fresh-install defaults: only default is pre-filled; other profiles start empty. */
export const DEFAULT_MODELS: Record<ModelProfile, string> = {
  default: DEFAULT_STORE_MODEL,
  fast: '',
  medium: '',
  high: '',
  custom: ''
}

function isModelProfile(value: unknown): value is ModelProfile {
  return (
    value === 'default' ||
    value === 'fast' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'custom'
  )
}

export function cloneModels(
  models: Partial<Record<ModelProfile, string>> | undefined
): Record<ModelProfile, string> {
  const result = { ...DEFAULT_MODELS }
  if (!models || typeof models !== 'object') {
    return result
  }
  for (const { id } of MODEL_PROFILES) {
    const value = models[id]
    if (typeof value === 'string') {
      result[id] = value
    }
  }
  return result
}

/** Normalize persisted or partial AI settings (incl. legacy `model` field). */
export function normalizeAISettings(raw: unknown): AISettings {
  const input = (raw ?? {}) as Partial<AISettings> & {
    model?: string
    /** @deprecated migrated to copilotModelProfile */
    modelProfile?: ModelProfile
  }
  const legacyModel = typeof input.model === 'string' ? input.model : ''

  const models = cloneModels(input.models)
  if (legacyModel && !input.models) {
    models.default = legacyModel
  } else if (legacyModel && input.models && typeof input.models.default !== 'string') {
    models.default = legacyModel
  }

  const legacyProfile = isModelProfile(input.modelProfile) ? input.modelProfile : undefined

  return {
    baseURL: typeof input.baseURL === 'string' ? input.baseURL : '',
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
    copilotModelProfile: isModelProfile(input.copilotModelProfile)
      ? input.copilotModelProfile
      : legacyProfile ?? 'default',
    nlModelProfile: isModelProfile(input.nlModelProfile) ? input.nlModelProfile : 'fast',
    models
  }
}

/** Resolve the model name for a given profile tier. */
export function resolveModel(settings: AISettings, profile: ModelProfile): string {
  const model = settings.models[profile]?.trim()
  return model || FALLBACK_MODEL
}

/** Resolve the model name for the Copilot sidebar profile. */
export function resolveActiveModel(settings: AISettings): string {
  return resolveModel(settings, settings.copilotModelProfile)
}
