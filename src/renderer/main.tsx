import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Load only the regular weight at boot; heavier weights are fetched after first paint.
import '@fontsource/sora/400.css'
import '@fontsource/jetbrains-mono/400.css'
import './styles/global.css'
import { applyTheme, readCachedTheme } from './lib/themes'
import { readCachedLocale } from './lib/i18n/locale'

void import('@fontsource/sora/500.css')
void import('@fontsource/sora/600.css')
void import('@fontsource/sora/700.css')
void import('@fontsource/jetbrains-mono/500.css')
void import('@fontsource/jetbrains-mono/700.css')

const locale = readCachedLocale()
// Load CJK fonts only when the UI is in Chinese — saves ~6 MB in the default bundle.
if (locale === 'zh') {
  void import('@fontsource/noto-sans-sc/chinese-simplified-400.css')
  void import('@fontsource/noto-sans-sc/chinese-simplified-500.css')
}

applyTheme(readCachedTheme())
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
