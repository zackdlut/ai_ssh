import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Latin-only subsets: UI is en/zh, terminal CJK comes from Noto. Skip greek /
// cyrillic / vietnamese / latin-ext that the full @fontsource CSS would ship.
import '@fontsource/sora/latin-400.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import './styles/global.css'
import { applyTheme, readCachedTheme } from './lib/themes'
import { readCachedLocale } from './lib/i18n/locale'

void import('@fontsource/sora/latin-500.css')
void import('@fontsource/sora/latin-600.css')
void import('@fontsource/sora/latin-700.css')
void import('@fontsource/jetbrains-mono/latin-500.css')
void import('@fontsource/jetbrains-mono/latin-700.css')

const locale = readCachedLocale()
// CJK only when the UI is Chinese. One weight: 500 is synthesized from 400.
if (locale === 'zh') {
  void import('@fontsource/noto-sans-sc/chinese-simplified-400.css')
}

applyTheme(readCachedTheme())
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
