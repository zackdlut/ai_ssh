import { DEFAULT_TERMINAL_FONT_FAMILY } from '../../shared/terminalSettings'

export type TerminalFontPresetId =
  | 'default-stack'
  | 'jetbrains-mono'
  | 'cascadia-code'
  | 'fira-code'
  | 'consolas'
  | 'menlo'
  | 'dejavu-sans-mono'
  | 'noto-sans-sc'
  | 'source-code-pro'
  | 'ibm-plex-mono'
  | 'ubuntu-mono'
  | 'system-monospace'

export interface TerminalFontPreset {
  id: TerminalFontPresetId
  fontFamily: string
  /** Primary face used to preview the option in the dropdown. */
  previewFamily: string
}

export const TERMINAL_FONT_PRESETS: TerminalFontPreset[] = [
  {
    id: 'default-stack',
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    previewFamily: "'JetBrains Mono', monospace"
  },
  {
    id: 'jetbrains-mono',
    fontFamily: "'JetBrains Mono', monospace",
    previewFamily: "'JetBrains Mono', monospace"
  },
  {
    id: 'cascadia-code',
    fontFamily: "'Cascadia Code', 'Cascadia Mono', monospace",
    previewFamily: "'Cascadia Code', monospace"
  },
  {
    id: 'fira-code',
    fontFamily: "'Fira Code', monospace",
    previewFamily: "'Fira Code', monospace"
  },
  {
    id: 'consolas',
    fontFamily: 'Consolas, monospace',
    previewFamily: 'Consolas, monospace'
  },
  {
    id: 'menlo',
    fontFamily: 'Menlo, monospace',
    previewFamily: 'Menlo, monospace'
  },
  {
    id: 'dejavu-sans-mono',
    fontFamily: "'DejaVu Sans Mono', monospace",
    previewFamily: "'DejaVu Sans Mono', monospace"
  },
  {
    id: 'noto-sans-sc',
    fontFamily:
      "'Noto Sans SC', 'Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'WenQuanYi Micro Hei', monospace",
    previewFamily: "'Noto Sans SC', monospace"
  },
  {
    id: 'source-code-pro',
    fontFamily: "'Source Code Pro', monospace",
    previewFamily: "'Source Code Pro', monospace"
  },
  {
    id: 'ibm-plex-mono',
    fontFamily: "'IBM Plex Mono', monospace",
    previewFamily: "'IBM Plex Mono', monospace"
  },
  {
    id: 'ubuntu-mono',
    fontFamily: "'Ubuntu Mono', monospace",
    previewFamily: "'Ubuntu Mono', monospace"
  },
  {
    id: 'system-monospace',
    fontFamily: 'monospace',
    previewFamily: 'monospace'
  }
]

export function matchTerminalFontPreset(fontFamily: string): TerminalFontPresetId | null {
  const preset = TERMINAL_FONT_PRESETS.find((p) => p.fontFamily === fontFamily)
  return preset?.id ?? null
}

/** First font family name for display when no preset matches. */
export function primaryFontName(fontFamily: string): string {
  const first = fontFamily.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]|['"]$/g, '') || fontFamily
}

export function previewFamilyForFont(fontFamily: string): string {
  const preset = TERMINAL_FONT_PRESETS.find((p) => p.fontFamily === fontFamily)
  if (preset) return preset.previewFamily
  const primary = primaryFontName(fontFamily)
  return primary === 'monospace' ? 'monospace' : `'${primary}', monospace`
}
