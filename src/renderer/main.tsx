import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
// Bundle the Simplified Chinese subset of Noto Sans SC so Chinese text renders
// even when the OS has no CJK font installed (otherwise it shows as tofu boxes).
// Latin glyphs keep falling back to the system UI font via the CSS stack.
import '@fontsource/noto-sans-sc/chinese-simplified-400.css'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
