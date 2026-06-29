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

const MIN_CONTEXT_LENGTH = 1024
const MAX_CONTEXT_LENGTH = 2_000_000

/** Fresh-install defaults: only default is pre-filled; other profiles start empty. */
export const DEFAULT_MODELS: Record<ModelProfile, string> = {
  default: DEFAULT_STORE_MODEL,
  fast: '',
  medium: '',
  high: '',
  custom: ''
}

/** Default context window (tokens) per profile tier. */
export const DEFAULT_CONTEXT_LENGTHS: Record<ModelProfile, number> = {
  default: 32768,
  fast: 8192,
  medium: 32768,
  high: 128000,
  custom: 32768
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

function clampContextLength(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < MIN_CONTEXT_LENGTH) return fallback
  return Math.min(MAX_CONTEXT_LENGTH, Math.round(value))
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

export function cloneContextLengths(
  lengths: Partial<Record<ModelProfile, number>> | undefined
): Record<ModelProfile, number> {
  const result = { ...DEFAULT_CONTEXT_LENGTHS }
  if (!lengths || typeof lengths !== 'object') {
    return result
  }
  for (const { id } of MODEL_PROFILES) {
    const value = lengths[id]
    if (typeof value === 'number') {
      result[id] = clampContextLength(value, DEFAULT_CONTEXT_LENGTHS[id])
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
    models,
    contextLengths: cloneContextLengths(input.contextLengths)
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

/** Resolve the context window (tokens) for a given profile tier. */
export function resolveContextLength(settings: AISettings, profile: ModelProfile): number {
  return settings.contextLengths[profile] ?? DEFAULT_CONTEXT_LENGTHS[profile]
}

/** Context window for the active Copilot profile. */
export function resolveActiveContextLength(settings: AISettings): number {
  return resolveContextLength(settings, settings.copilotModelProfile)
}
