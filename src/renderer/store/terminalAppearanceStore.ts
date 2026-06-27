import { create } from 'zustand'
import {
  DEFAULT_TERMINAL_APPEARANCE,
  normalizeTerminalAppearanceSettings,
  type TerminalAppearanceSettings
} from '../../shared/terminalSettings'

interface TerminalAppearanceState extends TerminalAppearanceSettings {
  loaded: boolean
  load: () => Promise<void>
  set: (partial: Partial<TerminalAppearanceSettings>) => Promise<void>
  resetField: <K extends keyof TerminalAppearanceSettings>(key: K) => Promise<void>
}

export const useTerminalAppearanceStore = create<TerminalAppearanceState>((set, get) => ({
  ...DEFAULT_TERMINAL_APPEARANCE,
  loaded: false,
  load: async () => {
    try {
      const settings = await window.api.config.getTerminalAppearance()
      const normalized = normalizeTerminalAppearanceSettings(settings)
      set({ ...normalized, loaded: true })
      if (settings && JSON.stringify(settings) !== JSON.stringify(normalized)) {
        await window.api.config.setTerminalAppearance(normalized)
      }
    } catch {
      set({ ...DEFAULT_TERMINAL_APPEARANCE, loaded: true })
    }
  },
  set: async (partial) => {
    const next = normalizeTerminalAppearanceSettings({ ...get(), ...partial })
    set(next)
    await window.api.config.setTerminalAppearance(next)
  },
  resetField: async (key) => {
    await get().set({ [key]: DEFAULT_TERMINAL_APPEARANCE[key] })
  }
}))
