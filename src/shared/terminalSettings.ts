export type TerminalColorSchemeId =
  | 'auto'
  | 'aurora'
  | 'dawn'
  | 'campbell'
  | 'campbell-powershell'
  | 'one-half-dark'
  | 'one-half-light'
  | 'solarized-dark'
  | 'solarized-light'
  | 'dark-plus'
  | 'tango-dark'
  | 'tango-light'

export type TerminalFontWeight =
  | 'thin'
  | 'extra-light'
  | 'light'
  | 'semi-light'
  | 'normal'
  | 'medium'
  | 'semi-bold'
  | 'bold'
  | 'extra-bold'
  | 'black'
  | 'extra-black'

export interface TerminalAppearanceSettings {
  colorScheme: TerminalColorSchemeId
  fontFamily: string
  fontSize: number
  lineHeight: number
  fontWeight: TerminalFontWeight
}

export const TERMINAL_COLOR_SCHEME_IDS: TerminalColorSchemeId[] = [
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

export const TERMINAL_FONT_WEIGHTS: TerminalFontWeight[] = [
  'thin',
  'extra-light',
  'light',
  'semi-light',
  'normal',
  'medium',
  'semi-bold',
  'bold',
  'extra-bold',
  'black',
  'extra-black'
]

/** Map stored weight id to a value accepted by xterm.js. */
export function xtermFontWeight(weight: TerminalFontWeight): number | 'normal' | 'bold' {
  switch (weight) {
    case 'thin':
      return 100
    case 'extra-light':
      return 200
    case 'light':
      return 300
    case 'semi-light':
      return 350
    case 'normal':
      return 'normal'
    case 'medium':
      return 500
    case 'semi-bold':
      return 600
    case 'bold':
      return 'bold'
    case 'extra-bold':
      return 800
    case 'black':
      return 900
    case 'extra-black':
      return 950
  }
}

const LEGACY_FONT_WEIGHT: Record<string, TerminalFontWeight> = {
  '100': 'thin',
  '200': 'extra-light',
  '300': 'light',
  '400': 'normal',
  '500': 'medium',
  '600': 'semi-bold',
  '700': 'bold',
  '800': 'extra-bold',
  '900': 'black'
}

export const DEFAULT_TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Menlo, 'DejaVu Sans Mono', 'Noto Sans SC', 'Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'WenQuanYi Micro Hei', monospace"

export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearanceSettings = {
  colorScheme: 'auto',
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  fontSize: 13,
  lineHeight: 1.25,
  fontWeight: 'normal'
}

/** xterm.js rejects lineHeight < 1 at runtime. */
export const MIN_TERMINAL_LINE_HEIGHT = 1
export const MAX_TERMINAL_LINE_HEIGHT = 2.5

const SCHEME_SET = new Set<string>(TERMINAL_COLOR_SCHEME_IDS)
const WEIGHT_SET = new Set<string>(TERMINAL_FONT_WEIGHTS)

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function normalizeTerminalAppearanceSettings(
  input: Partial<TerminalAppearanceSettings> | null | undefined
): TerminalAppearanceSettings {
  const base = DEFAULT_TERMINAL_APPEARANCE
  if (!input) return { ...base }

  const colorScheme = SCHEME_SET.has(input.colorScheme ?? '')
    ? (input.colorScheme as TerminalColorSchemeId)
    : base.colorScheme

  const fontFamily =
    typeof input.fontFamily === 'string' && input.fontFamily.trim()
      ? input.fontFamily.trim()
      : base.fontFamily

  const fontSize =
    typeof input.fontSize === 'number' && Number.isFinite(input.fontSize)
      ? clamp(Math.round(input.fontSize), 8, 32)
      : base.fontSize

  const lineHeight =
    typeof input.lineHeight === 'number' && Number.isFinite(input.lineHeight)
      ? clamp(
          Math.round(input.lineHeight * 100) / 100,
          MIN_TERMINAL_LINE_HEIGHT,
          MAX_TERMINAL_LINE_HEIGHT
        )
      : base.lineHeight

  const fontWeightRaw = input.fontWeight ?? ''
  const fontWeight = WEIGHT_SET.has(fontWeightRaw)
    ? (fontWeightRaw as TerminalFontWeight)
    : LEGACY_FONT_WEIGHT[fontWeightRaw] ?? base.fontWeight

  return { colorScheme, fontFamily, fontSize, lineHeight, fontWeight }
}
