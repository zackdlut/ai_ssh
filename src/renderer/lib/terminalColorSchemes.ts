import type { ITheme } from '@xterm/xterm'
import type { AppTheme } from '../../shared/types'
import type { TerminalColorSchemeId } from '../../shared/terminalSettings'
import { XTERM_THEMES } from './themes'

function parseHexColor(input: string): [number, number, number] | null {
  const hex = input.trim().replace(/^#/, '')
  if (hex.length === 3) {
    return hex.split('').map((c) => parseInt(c + c, 16)) as [number, number, number]
  }
  if (hex.length === 6 || hex.length === 8) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16)
    ]
  }
  return null
}

function parseRgbaColor(input: string): [number, number, number, number] | null {
  const rgba = input.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
  if (!rgba) return null
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] !== undefined ? Number(rgba[4]) : 1]
}

function toHexByte(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')
}

/**
 * xterm pre-blends selection tint onto theme.background. With a transparent
 * canvas (follow-app-theme), that blend uses black and looks far too dark on
 * light themes — so we bake the tint against the real panel surface instead.
 */
function blendSelectionOnBackground(surfaceHex: string, selectionColor: string): string {
  const surface = parseHexColor(surfaceHex)
  const selection = parseRgbaColor(selectionColor)
  if (!surface || !selection) return selectionColor

  const [br, bg, bb] = surface
  const [fr, fg, fb, alpha] = selection
  if (alpha >= 1) return `#${toHexByte(fr)}${toHexByte(fg)}${toHexByte(fb)}`

  const r = Math.round(br + (fr - br) * alpha)
  const g = Math.round(bg + (fg - bg) * alpha)
  const b = Math.round(bb + (fb - bb) * alpha)
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`
}

/** Fixed terminal color palettes (excludes `auto`). */
export const TERMINAL_COLOR_SCHEMES: Record<Exclude<TerminalColorSchemeId, 'auto'>, ITheme> = {
  aurora: XTERM_THEMES.aurora,
  dawn: XTERM_THEMES.dawn,
  campbell: {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#ffffff',
    cursorAccent: '#0c0c0c',
    selectionBackground: 'rgba(255, 255, 255, 0.3)',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2'
  },
  'campbell-powershell': {
    background: '#012456',
    foreground: '#cccccc',
    cursor: '#ffffff',
    cursorAccent: '#012456',
    selectionBackground: 'rgba(255, 255, 255, 0.3)',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2'
  },
  'one-half-dark': {
    background: '#282c34',
    foreground: '#dcdfe4',
    cursor: '#a3b3cc',
    cursorAccent: '#282c34',
    selectionBackground: 'rgba(97, 175, 239, 0.3)',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#dcdfe4',
    brightBlack: '#5a6374',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#dcdfe4'
  },
  'one-half-light': {
    background: '#fafafa',
    foreground: '#383a42',
    cursor: '#526eff',
    cursorAccent: '#fafafa',
    selectionBackground: 'rgba(80, 120, 255, 0.25)',
    black: '#383a42',
    red: '#e45649',
    green: '#50a14f',
    yellow: '#c18401',
    blue: '#0184bc',
    magenta: '#a626a4',
    cyan: '#0997b3',
    white: '#fafafa',
    brightBlack: '#4f525e',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff'
  },
  'solarized-dark': {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    cursorAccent: '#002b36',
    selectionBackground: 'rgba(147, 161, 161, 0.3)',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3'
  },
  'solarized-light': {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#657b83',
    cursorAccent: '#fdf6e3',
    selectionBackground: 'rgba(101, 123, 131, 0.25)',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3'
  },
  'dark-plus': {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#ffffff',
    cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(255, 255, 255, 0.25)',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5'
  },
  'tango-dark': {
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(255, 255, 255, 0.3)',
    black: '#000000',
    red: '#cc0000',
    green: '#4e9a06',
    yellow: '#c4a000',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#06989a',
    white: '#d3d7cf',
    brightBlack: '#555753',
    brightRed: '#ef2929',
    brightGreen: '#8ae234',
    brightYellow: '#fce94f',
    brightBlue: '#729fcf',
    brightMagenta: '#ad7fa8',
    brightCyan: '#34e2e2',
    brightWhite: '#eeeeec'
  },
  'tango-light': {
    background: '#ffffff',
    foreground: '#000000',
    cursor: '#000000',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(0, 0, 0, 0.2)',
    black: '#000000',
    red: '#cc0000',
    green: '#4e9a06',
    yellow: '#c4a000',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#06989a',
    white: '#d3d7cf',
    brightBlack: '#555753',
    brightRed: '#ef2929',
    brightGreen: '#8ae234',
    brightYellow: '#fce94f',
    brightBlue: '#729fcf',
    brightMagenta: '#ad7fa8',
    brightCyan: '#34e2e2',
    brightWhite: '#eeeeec'
  }
}

export const TERMINAL_COLOR_SCHEME_OPTIONS: TerminalColorSchemeId[] = [
  'auto',
  'aurora',
  'dawn',
  'campbell',
  'campbell-powershell',
  'one-half-dark',
  'one-half-light',
  'solarized-dark',
  'solarized-light',
  'dark-plus',
  'tango-dark',
  'tango-light'
]

export function isFollowAppTheme(colorScheme: TerminalColorSchemeId): boolean {
  return colorScheme === 'auto'
}

export function resolveTerminalTheme(
  colorScheme: TerminalColorSchemeId,
  appTheme: AppTheme
): ITheme {
  const appFallback = XTERM_THEMES[appTheme] ?? XTERM_THEMES.dawn
  if (colorScheme === 'auto') {
    return appFallback
  }
  return TERMINAL_COLOR_SCHEMES[colorScheme] ?? appFallback
}

/** xterm theme: transparent canvas when following app theme so --panel-bg shows through. */
export function xtermThemeForDisplay(
  colorScheme: TerminalColorSchemeId,
  appTheme: AppTheme
): ITheme {
  const theme = resolveTerminalTheme(colorScheme, appTheme)
  if (!isFollowAppTheme(colorScheme)) return theme

  const surface = theme.background ?? '#f4f5f8'
  const selection = theme.selectionBackground ?? 'rgba(255, 255, 255, 0.3)'
  const opaqueSelection = blendSelectionOnBackground(surface, selection)
  const opaqueInactive = theme.selectionInactiveBackground
    ? blendSelectionOnBackground(surface, theme.selectionInactiveBackground)
    : opaqueSelection

  return {
    ...theme,
    background: '#00000000',
    cursorAccent: '#00000000',
    selectionBackground: opaqueSelection,
    selectionInactiveBackground: opaqueInactive
  }
}

/** 16 ANSI swatch colors for dropdown preview (normal + bright). */
export function terminalSwatchColors(theme: ITheme): string[] {
  return [
    theme.black ?? '#000',
    theme.red ?? '#f00',
    theme.green ?? '#0f0',
    theme.yellow ?? '#ff0',
    theme.blue ?? '#00f',
    theme.magenta ?? '#f0f',
    theme.cyan ?? '#0ff',
    theme.white ?? '#fff',
    theme.brightBlack ?? '#888',
    theme.brightRed ?? '#f88',
    theme.brightGreen ?? '#8f8',
    theme.brightYellow ?? '#ff8',
    theme.brightBlue ?? '#88f',
    theme.brightMagenta ?? '#f8f',
    theme.brightCyan ?? '#8ff',
    theme.brightWhite ?? '#fff'
  ]
}

export function previewThemeForScheme(
  colorScheme: TerminalColorSchemeId,
  appTheme: AppTheme
): ITheme {
  return resolveTerminalTheme(colorScheme, appTheme)
}
