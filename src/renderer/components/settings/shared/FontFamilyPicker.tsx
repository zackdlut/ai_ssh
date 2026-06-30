import { useEffect, useRef, useState } from 'react'
import { terminalFontPresetLabel, useT } from '../../../lib/i18n'
import {
  TERMINAL_FONT_PRESETS,
  matchTerminalFontPreset,
  previewFamilyForFont,
  primaryFontName
} from '../../../lib/terminalFonts'
import { useLocaleStore } from '../../../store/localeStore'

export default function FontFamilyPicker({
  value,
  onChange,
  disabled = false
}: {
  value: string
  onChange: (fontFamily: string) => void
  disabled?: boolean
}): JSX.Element {
  const locale = useLocaleStore((s) => s.locale)
  const t = useT()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const activePresetId = matchTerminalFontPreset(value)
  const displayLabel = activePresetId
    ? terminalFontPresetLabel(locale, activePresetId)
    : primaryFontName(value)
  const displayPreviewFamily = previewFamilyForFont(value)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className={`terminal-font-dropdown${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="terminal-font-trigger"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span
          className="terminal-font-trigger-label"
          style={{ fontFamily: displayPreviewFamily }}
        >
          {displayLabel}
        </span>
        <span className="terminal-font-trigger-caret">▾</span>
      </button>
      {open && !disabled && (
        <div className="terminal-font-menu" role="listbox">
          {TERMINAL_FONT_PRESETS.map((preset) => {
            const active = preset.id === activePresetId
            return (
              <button
                key={preset.id}
                type="button"
                role="option"
                aria-selected={active}
                className={`terminal-font-option${active ? ' active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(preset.fontFamily)
                  setOpen(false)
                }}
              >
                <span className="terminal-font-option-label">
                  {terminalFontPresetLabel(locale, preset.id)}
                </span>
                <span
                  className="terminal-font-option-sample"
                  style={{ fontFamily: preset.previewFamily }}
                >
                  {t('settings.terminal.fontSample')}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
