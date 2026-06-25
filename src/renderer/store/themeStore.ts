import { create } from 'zustand'
import type { AppTheme } from '../../shared/types'
import { applyTheme, readCachedTheme } from '../lib/themes'

interface ThemeState {
  theme: AppTheme
  loaded: boolean
  load: () => Promise<void>
  setTheme: (theme: AppTheme) => Promise<void>
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readCachedTheme(),
  loaded: false,
  load: async () => {
    const theme = await window.api.config.getTheme()
    applyTheme(theme)
    set({ theme, loaded: true })
  },
  setTheme: async (theme) => {
    applyTheme(theme)
    set({ theme })
    await window.api.config.setTheme(theme)
  }
}))
