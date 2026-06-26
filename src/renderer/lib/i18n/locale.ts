import type { AppLocale } from '../../shared/types'

const LOCALE_CACHE_KEY = 'app.locale'

export function readCachedLocale(): AppLocale {
  const cached = localStorage.getItem(LOCALE_CACHE_KEY)
  return cached === 'en' ? 'en' : 'zh'
}
