import type { ITheme } from '@xterm/xterm'
import type { AppTheme } from '../../shared/types'

const THEME_CACHE_KEY = 'app.theme'

export interface ThemeMeta {
  id: AppTheme
  label: string
  description: string
  /** Short tag shown on the preview card. */
  tag: string
}

export const THEME_OPTIONS: ThemeMeta[] = [
  {
    id: 'aurora',
    label: 'Aurora Ink',
    description: '深墨底色与极光微光，适合长时间终端工作',
    tag: 'Dark'
  },
  {
    id: 'dawn',
    label: 'Dawn Paper',
    description: '暖色纸感浅底，清晰对比与柔和阴影',
    tag: 'Light'
  }
]

export const XTERM_THEMES: Record<AppTheme, ITheme> = {
  aurora: {
    background: '#04060b',
    foreground: '#e7ebf6',
    cursor: '#5be9d0',
    cursorAccent: '#04060b',
    selectionBackground: 'rgba(91, 233, 208, 0.28)',
    black: '#0a0d15',
    red: '#ff7a93',
    green: '#82e8b6',
    yellow: '#ffce6a',
    blue: '#74a8ff',
    magenta: '#b292ff',
    cyan: '#5be9d0',
    white: '#cdd3e3',
    brightBlack: '#5d6479',
    brightRed: '#ff95a9',
    brightGreen: '#9bf0c7',
    brightYellow: '#ffd98a',
    brightBlue: '#93bcff',
    brightMagenta: '#c8adff',
    brightCyan: '#7ff0dd',
    brightWhite: '#f4f7ff'
  },
  dawn: {
    background: '#faf9f6',
    foreground: '#1a1f2e',
    cursor: '#0a9d87',
    cursorAccent: '#faf9f6',
    selectionBackground: 'rgba(10, 157, 135, 0.22)',
    black: '#2a3142',
    red: '#c93d58',
    green: '#1a9a62',
    yellow: '#b8860f',
    blue: '#3b6fd9',
    magenta: '#7c5dd4',
    cyan: '#0a9d87',
    white: '#4a5168',
    brightBlack: '#6b728a',
    brightRed: '#e25572',
    brightGreen: '#22b574',
    brightYellow: '#d4a017',
    brightBlue: '#5a8ef0',
    brightMagenta: '#9470e8',
    brightCyan: '#1bb89f',
    brightWhite: '#1a1f2e'
  }
}

export function readCachedTheme(): AppTheme {
  const cached = localStorage.getItem(THEME_CACHE_KEY)
  return cached === 'dawn' ? 'dawn' : 'aurora'
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(THEME_CACHE_KEY, theme)
}

export function mermaidThemeFor(theme: AppTheme): 'dark' | 'default' {
  return theme === 'dawn' ? 'default' : 'dark'
}
