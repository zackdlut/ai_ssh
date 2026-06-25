import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
// Distinctive UI typeface (geometric grotesque) bundled locally so it loads
// offline and satisfies the strict `font-src 'self'` CSP.
import '@fontsource/sora/400.css'
import '@fontsource/sora/500.css'
import '@fontsource/sora/600.css'
import '@fontsource/sora/700.css'
// Technical monospace for the terminal and command cards.
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
// Bundle the Simplified Chinese subset of Noto Sans SC so Chinese text renders
// even when the OS has no CJK font installed (otherwise it shows as tofu boxes).
// Latin glyphs keep falling back to the system UI font via the CSS stack.
import '@fontsource/noto-sans-sc/chinese-simplified-400.css'
import '@fontsource/noto-sans-sc/chinese-simplified-500.css'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
