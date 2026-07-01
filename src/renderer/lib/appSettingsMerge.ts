import { normalizeAISettings } from '../../shared/aiSettings'
import type { AISettings, AppLocale, AppTheme, ModelProfile } from '../../shared/types'
import {
  DEFAULT_TERMINAL_APPEARANCE,
  normalizeTerminalAppearanceSettings,
  type TerminalAppearanceSettings,
  type TerminalColorSchemeId,
  type TerminalFontWeight
} from '../../shared/terminalSettings'

export interface StartupSettings {
  connSidebarOpen: boolean
  copilotOpen: boolean
}

export interface AppSettingsSnapshot {
  theme: AppTheme
  locale: AppLocale
  terminal_appearance: TerminalAppearanceSettings
  startup: StartupSettings
  ai: {
    baseURL: string
    hasApiKey: boolean
    copilotModelProfile: ModelProfile
    nlModelProfile: ModelProfile
    models: Record<ModelProfile, string>
    contextLengths: Record<ModelProfile, number>
  }
}

function isAppTheme(v: unknown): v is AppTheme {
  return v === 'aurora' || v === 'dawn'
}

function isAppLocale(v: unknown): v is AppLocale {
  return v === 'zh' || v === 'en'
}

function isModelProfile(v: unknown): v is ModelProfile {
  return v === 'default' || v === 'fast' || v === 'medium' || v === 'high' || v === 'custom'
}

function parseTerminalAppearance(raw: unknown): TerminalAppearanceSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TERMINAL_APPEARANCE }
  return normalizeTerminalAppearanceSettings(raw as Partial<TerminalAppearanceSettings>)
}

const DEFAULT_STARTUP: StartupSettings = { connSidebarOpen: false, copilotOpen: true }

function parseStartup(raw: unknown): StartupSettings {
  const result = { ...DEFAULT_STARTUP }
  if (!raw || typeof raw !== 'object') return result
  const input = raw as Record<string, unknown>
  if (typeof input.connSidebarOpen === 'boolean') result.connSidebarOpen = input.connSidebarOpen
  if (typeof input.copilotOpen === 'boolean') result.copilotOpen = input.copilotOpen
  return result
}

function parseAiSnapshot(raw: unknown, fallback?: AISettings): AppSettingsSnapshot['ai'] {
  const base = fallback ? normalizeAISettings(fallback) : normalizeAISettings({})
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const models = { ...base.models }
  const contextLengths = { ...base.contextLengths }

  if (input.models && typeof input.models === 'object') {
    for (const [key, value] of Object.entries(input.models as Record<string, unknown>)) {
      if (isModelProfile(key) && typeof value === 'string') models[key] = value
    }
  }
  if (input.contextLengths && typeof input.contextLengths === 'object') {
    for (const [key, value] of Object.entries(input.contextLengths as Record<string, unknown>)) {
      if (isModelProfile(key) && typeof value === 'number') contextLengths[key] = value
    }
  }

  return {
    baseURL: typeof input.baseURL === 'string' ? input.baseURL : base.baseURL,
    hasApiKey: typeof input.hasApiKey === 'boolean' ? input.hasApiKey : !!base.apiKey,
    copilotModelProfile: isModelProfile(input.copilotModelProfile)
      ? input.copilotModelProfile
      : base.copilotModelProfile,
    nlModelProfile: isModelProfile(input.nlModelProfile)
      ? input.nlModelProfile
      : base.nlModelProfile,
    models,
    contextLengths
  }
}

/** Parse tool result or partial settings object into a normalized snapshot. */
export function parseAppSettingsSnapshot(
  raw: Record<string, unknown>,
  aiFallback?: AISettings
): AppSettingsSnapshot {
  const theme = isAppTheme(raw.theme) ? raw.theme : 'aurora'
  const locale = isAppLocale(raw.locale) ? raw.locale : 'zh'
  return {
    theme,
    locale,
    terminal_appearance: parseTerminalAppearance(raw.terminal_appearance),
    startup: parseStartup(raw.startup),
    ai: parseAiSnapshot(raw.ai, aiFallback)
  }
}

/** Build snapshot from live app stores (for edit-mode baseline). */
export async function buildCurrentAppSettingsSnapshot(): Promise<AppSettingsSnapshot> {
  const { useThemeStore } = await import('../store/themeStore')
  const { useLocaleStore } = await import('../store/localeStore')
  const { useTerminalAppearanceStore } = await import('../store/terminalAppearanceStore')
  const { useStartupStore } = await import('../store/startupStore')

  const theme = useThemeStore.getState().theme
  const locale = useLocaleStore.getState().locale
  const terminal = useTerminalAppearanceStore.getState()
  const startup = useStartupStore.getState()
  const ai = normalizeAISettings(await window.api.config.getAISettings())

  return {
    theme,
    locale,
    terminal_appearance: {
      colorScheme: terminal.colorScheme,
      fontFamily: terminal.fontFamily,
      fontSize: terminal.fontSize,
      lineHeight: terminal.lineHeight,
      fontWeight: terminal.fontWeight
    },
    startup: {
      connSidebarOpen: startup.connSidebarOpen,
      copilotOpen: startup.copilotOpen
    },
    ai: {
      baseURL: ai.baseURL,
      hasApiKey: !!ai.apiKey,
      copilotModelProfile: ai.copilotModelProfile,
      nlModelProfile: ai.nlModelProfile,
      models: { ...ai.models },
      contextLengths: { ...ai.contextLengths }
    }
  }
}

/** Deep-merge proposed updates onto a baseline snapshot for live preview. */
export function mergeAppSettingsUpdates(
  baseline: AppSettingsSnapshot,
  updates: Record<string, unknown>
): AppSettingsSnapshot {
  const next: AppSettingsSnapshot = {
    theme: baseline.theme,
    locale: baseline.locale,
    terminal_appearance: { ...baseline.terminal_appearance },
    startup: { ...baseline.startup },
    ai: {
      ...baseline.ai,
      models: { ...baseline.ai.models },
      contextLengths: { ...baseline.ai.contextLengths }
    }
  }

  if (isAppTheme(updates.theme)) next.theme = updates.theme
  if (isAppLocale(updates.locale)) next.locale = updates.locale

  if (updates.startup && typeof updates.startup === 'object') {
    const s = updates.startup as Record<string, unknown>
    if (typeof s.connSidebarOpen === 'boolean') next.startup.connSidebarOpen = s.connSidebarOpen
    if (typeof s.copilotOpen === 'boolean') next.startup.copilotOpen = s.copilotOpen
  }

  if (updates.terminal_appearance && typeof updates.terminal_appearance === 'object') {
    const ta = updates.terminal_appearance as Record<string, unknown>
    if (typeof ta.colorScheme === 'string') {
      next.terminal_appearance.colorScheme = ta.colorScheme as TerminalColorSchemeId
    }
    if (typeof ta.fontFamily === 'string') next.terminal_appearance.fontFamily = ta.fontFamily
    if (typeof ta.fontSize === 'number') next.terminal_appearance.fontSize = ta.fontSize
    if (typeof ta.lineHeight === 'number') next.terminal_appearance.lineHeight = ta.lineHeight
    if (typeof ta.fontWeight === 'string') {
      next.terminal_appearance.fontWeight = ta.fontWeight as TerminalFontWeight
    }
  }

  if (updates.ai && typeof updates.ai === 'object') {
    const ai = updates.ai as Record<string, unknown>
    if (typeof ai.baseURL === 'string') next.ai.baseURL = ai.baseURL
    if (typeof ai.apiKey === 'string' && ai.apiKey) next.ai.hasApiKey = true
    if (isModelProfile(ai.copilotModelProfile)) next.ai.copilotModelProfile = ai.copilotModelProfile
    if (isModelProfile(ai.nlModelProfile)) next.ai.nlModelProfile = ai.nlModelProfile
    if (ai.models && typeof ai.models === 'object') {
      for (const [key, value] of Object.entries(ai.models as Record<string, unknown>)) {
        if (isModelProfile(key) && typeof value === 'string') next.ai.models[key] = value
      }
    }
    if (ai.contextLengths && typeof ai.contextLengths === 'object') {
      for (const [key, value] of Object.entries(ai.contextLengths as Record<string, unknown>)) {
        if (isModelProfile(key) && typeof value === 'number') next.ai.contextLengths[key] = value
      }
    }
  }

  return next
}

export function hasUiUpdates(updates: Record<string, unknown>): boolean {
  return updates.theme !== undefined || updates.locale !== undefined
}

export function hasTerminalUpdates(updates: Record<string, unknown>): boolean {
  return updates.terminal_appearance !== undefined
}

export function hasStartupUpdates(updates: Record<string, unknown>): boolean {
  return updates.startup !== undefined
}

export function startupFieldChanged(
  updates: Record<string, unknown>,
  field: keyof StartupSettings
): boolean {
  const s = updates.startup
  if (!s || typeof s !== 'object') return false
  return (s as Record<string, unknown>)[field] !== undefined
}

export function hasAiUpdates(updates: Record<string, unknown>): boolean {
  return updates.ai !== undefined
}

export function terminalFieldChanged(
  updates: Record<string, unknown>,
  field: keyof TerminalAppearanceSettings
): boolean {
  const ta = updates.terminal_appearance
  if (!ta || typeof ta !== 'object') return false
  return (ta as Record<string, unknown>)[field as string] !== undefined
}

export function aiFieldChanged(updates: Record<string, unknown>, field: string): boolean {
  const ai = updates.ai
  if (!ai || typeof ai !== 'object') return false
  return (ai as Record<string, unknown>)[field] !== undefined
}

export function aiNestedFieldChanged(
  updates: Record<string, unknown>,
  group: 'models' | 'contextLengths',
  profile: ModelProfile
): boolean {
  const ai = updates.ai
  if (!ai || typeof ai !== 'object') return false
  const groupObj = (ai as Record<string, unknown>)[group]
  if (!groupObj || typeof groupObj !== 'object') return false
  return (groupObj as Record<string, unknown>)[profile] !== undefined
}
