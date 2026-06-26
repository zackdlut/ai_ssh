import { create } from 'zustand'
import type { AppLocale } from '../../shared/types'
import { readCachedLocale } from '../lib/i18n/locale'

function applyLocale(locale: AppLocale): void {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  localStorage.setItem('app.locale', locale)
}

interface LocaleState {
  locale: AppLocale
  loaded: boolean
  load: () => Promise<void>
  setLocale: (locale: AppLocale) => Promise<void>
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: readCachedLocale(),
  loaded: false,
  load: async () => {
    const locale = await window.api.config.getLocale()
    applyLocale(locale)
    set({ locale, loaded: true })
  },
  setLocale: async (locale) => {
    applyLocale(locale)
    set({ locale })
    await window.api.config.setLocale(locale)
  }
}))
