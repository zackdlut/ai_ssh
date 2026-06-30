import { useEffect, useRef, useState } from 'react'
import {
  TERMINAL_COLOR_SCHEME_OPTIONS,
  previewThemeForScheme,
  terminalSwatchColors
} from '../../../lib/terminalColorSchemes'
import { terminalSchemeLabel } from '../../../lib/i18n'
import { useLocaleStore } from '../../../store/localeStore'
import { useThemeStore } from '../../../store/themeStore'
import type { TerminalColorSchemeId } from '../../../../shared/terminalSettings'
import { ColorSwatch } from './TerminalPreview'

export default function ColorSchemeDropdown({
  value,
  onChange,
  disabled = false
}: {
  value: TerminalColorSchemeId
  onChange: (id: TerminalColorSchemeId) => void
  disabled?: boolean
}): JSX.Element {
  const locale = useLocaleStore((s) => s.locale)
  const appTheme = useThemeStore((s) => s.theme)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const selectedTheme = previewThemeForScheme(value, appTheme)
  const selectedLabel = terminalSchemeLabel(locale, value)

  return (
    <div className={`terminal-scheme-dropdown${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="terminal-scheme-trigger"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ColorSwatch colors={terminalSwatchColors(selectedTheme)} />
        <span className="terminal-scheme-trigger-label">{selectedLabel}</span>
        <span className="terminal-scheme-trigger-caret">▾</span>
      </button>
      {open && !disabled && (
        <div className="terminal-scheme-menu" role="listbox">
          {TERMINAL_COLOR_SCHEME_OPTIONS.map((id) => {
            const theme = previewThemeForScheme(id, appTheme)
            const active = id === value
            return (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={active}
                className={`terminal-scheme-option ${active ? 'active' : ''}`}
                onClick={() => {
                  onChange(id)
                  setOpen(false)
                }}
              >
                <ColorSwatch colors={terminalSwatchColors(theme)} />
                <span>{terminalSchemeLabel(locale, id)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
