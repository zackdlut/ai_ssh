import type { AISettings, AutonomyMode, ModelProfile } from './types'
import { DEFAULT_AUTONOMY_MODE } from './toolPolicy'

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

/** Fresh-install base URLs: all empty (each profile falls back to `default`). */
export const DEFAULT_BASE_URLS: Record<ModelProfile, string> = {
  default: '',
  fast: '',
  medium: '',
  high: '',
  custom: ''
}

/** Fresh-install API keys: all empty (each profile falls back to `default`). */
export const DEFAULT_API_KEYS: Record<ModelProfile, string> = {
  default: '',
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

function isAutonomyMode(value: unknown): value is AutonomyMode {
  return value === 'conservative' || value === 'balanced' || value === 'autonomous'
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

function cloneStringMap(
  values: Partial<Record<ModelProfile, string>> | undefined,
  defaults: Record<ModelProfile, string>
): Record<ModelProfile, string> {
  const result = { ...defaults }
  if (!values || typeof values !== 'object') {
    return result
  }
  for (const { id } of MODEL_PROFILES) {
    const value = values[id]
    if (typeof value === 'string') {
      result[id] = value
    }
  }
  return result
}

export function cloneBaseURLs(
  values: Partial<Record<ModelProfile, string>> | undefined
): Record<ModelProfile, string> {
  return cloneStringMap(values, DEFAULT_BASE_URLS)
}

export function cloneApiKeys(
  values: Partial<Record<ModelProfile, string>> | undefined
): Record<ModelProfile, string> {
  return cloneStringMap(values, DEFAULT_API_KEYS)
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
    /** @deprecated migrated to baseURLs.default */
    baseURL?: string
    /** @deprecated migrated to apiKeys.default */
    apiKey?: string
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

  // Migrate the previously-shared scalar baseURL/apiKey into the `default` slot
  // so existing installs keep working when the fields become per-profile.
  const legacyBaseURL = typeof input.baseURL === 'string' ? input.baseURL : ''
  const baseURLs = cloneBaseURLs(input.baseURLs)
  if (legacyBaseURL && (!input.baseURLs || typeof input.baseURLs.default !== 'string')) {
    baseURLs.default = legacyBaseURL
  }

  const legacyApiKey = typeof input.apiKey === 'string' ? input.apiKey : ''
  const apiKeys = cloneApiKeys(input.apiKeys)
  if (legacyApiKey && (!input.apiKeys || typeof input.apiKeys.default !== 'string')) {
    apiKeys.default = legacyApiKey
  }

  const legacyProfile = isModelProfile(input.modelProfile) ? input.modelProfile : undefined

  const httpProxy = typeof input.httpProxy === 'string' ? input.httpProxy.trim() : ''

  return {
    baseURLs,
    apiKeys,
    copilotModelProfile: isModelProfile(input.copilotModelProfile)
      ? input.copilotModelProfile
      : legacyProfile ?? 'default',
    nlModelProfile: isModelProfile(input.nlModelProfile) ? input.nlModelProfile : 'fast',
    models,
    contextLengths: cloneContextLengths(input.contextLengths),
    httpProxy,
    copilotAutonomy: isAutonomyMode(input.copilotAutonomy)
      ? input.copilotAutonomy
      : DEFAULT_AUTONOMY_MODE
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

/** Resolve the base URL for a profile, falling back to the `default` profile. */
export function resolveBaseURL(settings: AISettings, profile: ModelProfile): string {
  const url = settings.baseURLs[profile]?.trim()
  if (url) return url
  return settings.baseURLs.default?.trim() || ''
}

/** Resolve the API key for a profile, falling back to the `default` profile. */
export function resolveApiKey(settings: AISettings, profile: ModelProfile): string {
  const key = settings.apiKeys[profile]?.trim()
  if (key) return key
  return settings.apiKeys.default?.trim() || ''
}

/** Resolve the context window (tokens) for a given profile tier. */
export function resolveContextLength(settings: AISettings, profile: ModelProfile): number {
  return settings.contextLengths[profile] ?? DEFAULT_CONTEXT_LENGTHS[profile]
}

/** Context window for the active Copilot profile. */
export function resolveActiveContextLength(settings: AISettings): number {
  return resolveContextLength(settings, settings.copilotModelProfile)
}

function envVar(name: string): string {
  if (typeof process === 'undefined' || !process.env) return ''
  return (process.env[name] || '').trim()
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function matchesNoProxyEntry(host: string, port: string, entry: string): boolean {
  if (entry === '*') return true

  let pattern = entry
  // An entry may pin a port (`example.com:8080`); such an entry only applies to
  // that port. Bare IPv6 literals contain colons too, so only split when the
  // tail looks like a port number.
  const portSplit = pattern.lastIndexOf(':')
  if (portSplit > 0 && /^\d+$/.test(pattern.slice(portSplit + 1))) {
    const wantPort = pattern.slice(portSplit + 1)
    if (port && port !== wantPort) return false
    pattern = pattern.slice(0, portSplit)
  }

  const slash = pattern.indexOf('/')
  if (slash > 0) {
    const prefixLen = Number(pattern.slice(slash + 1))
    const network = ipv4ToInt(pattern.slice(0, slash))
    const target = ipv4ToInt(host)
    if (network === null || target === null) return false
    if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) return false
    if (prefixLen === 0) return true
    const mask = (0xffffffff << (32 - prefixLen)) >>> 0
    return ((network & mask) >>> 0) === ((target & mask) >>> 0)
  }

  const bare = pattern.replace(/^\./, '')
  if (!bare) return false
  return host === bare || host.endsWith(`.${bare}`)
}

/**
 * Whether `targetUrl` is listed in the `NO_PROXY` environment variable.
 *
 * Follows the de-facto convention: comma-separated entries, `*` bypasses
 * everything, a leading dot or bare domain matches subdomains, an optional
 * `:port` suffix narrows the entry, and IPv4 CIDR blocks are honoured so the
 * common `10.0.0.0/8` style entry works.
 */
export function shouldBypassProxy(targetUrl: string, noProxy?: string): boolean {
  const raw = (noProxy ?? (envVar('NO_PROXY') || envVar('no_proxy'))).trim()
  if (!raw) return false

  let host: string
  let port: string
  try {
    const parsed = new URL(targetUrl)
    host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    port = parsed.port
  } catch {
    return false
  }
  if (!host) return false

  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => matchesNoProxyEntry(host, port, entry))
}

/**
 * Resolve HTTP(S) proxy for AI API requests; falls back to env when unset.
 *
 * `targetUrl` is checked against `NO_PROXY` first. Skipping that check forces
 * corporate-proxy traffic for endpoints the environment declares directly
 * reachable — typically a LAN or loopback model server, which the proxy then
 * refuses to CONNECT to.
 */
export function resolveHttpProxy(settings: AISettings, targetUrl?: string): string {
  if (targetUrl && shouldBypassProxy(targetUrl)) return ''
  const configured = settings.httpProxy?.trim()
  if (configured) return configured
  return envVar('HTTPS_PROXY') || envVar('HTTP_PROXY') || envVar('https_proxy') || envVar('http_proxy')
}
