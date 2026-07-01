import { create } from 'zustand'
import {
  DEFAULT_KEYBINDINGS,
  normalizeKeybindingsSettings,
  type KeybindingId,
  type KeybindingsSettings
} from '../../shared/keybindings'

interface KeybindingsState extends KeybindingsSettings {
  loaded: boolean
  load: () => Promise<void>
  set: (partial: Partial<KeybindingsSettings>) => Promise<void>
  resetField: (key: KeybindingId) => Promise<void>
}

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  ...DEFAULT_KEYBINDINGS,
  loaded: false,
  load: async () => {
    try {
      const settings = await window.api.config.getKeybindings()
      const normalized = normalizeKeybindingsSettings(settings)
      set({ ...normalized, loaded: true })
      if (settings && JSON.stringify(settings) !== JSON.stringify(normalized)) {
        await window.api.config.setKeybindings(normalized)
      }
    } catch {
      set({ ...DEFAULT_KEYBINDINGS, loaded: true })
    }
  },
  set: async (partial) => {
    const next = normalizeKeybindingsSettings({ ...get(), ...partial })
    set(next)
    await window.api.config.setKeybindings(next)
  },
  resetField: async (key) => {
    await get().set({ [key]: DEFAULT_KEYBINDINGS[key] })
  }
}))
