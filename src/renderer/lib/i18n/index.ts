import { useCallback } from 'react'
import { useLocaleStore } from '../../store/localeStore'
import type { ModelProfile } from '../../../shared/types'
import type { AppTheme } from '../../../shared/types'
import {
  translate,
  translations,
  type AppLocale,
  type TranslationKey
} from './translations'

export type { AppLocale, TranslationKey }
export { translate as t, translations }

export function useT(): (
  key: TranslationKey,
  vars?: Record<string, string | number>
) => string {
  const locale = useLocaleStore((s) => s.locale)
  return useCallback((key, vars) => translate(locale, key, vars), [locale])
}

export function modelProfileLabel(locale: AppLocale, profile: ModelProfile): string {
  return translate(locale, `model.${profile}` as TranslationKey)
}

export function themeMeta(locale: AppLocale, id: AppTheme): {
  label: string
  description: string
  tag: string
} {
  return {
    label: translate(locale, `theme.${id}.label` as TranslationKey),
    description: translate(locale, `theme.${id}.description` as TranslationKey),
    tag: translate(locale, `theme.${id}.tag` as TranslationKey)
  }
}
