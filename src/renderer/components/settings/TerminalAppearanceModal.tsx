import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ITheme } from '@xterm/xterm'
import {
  TERMINAL_COLOR_SCHEME_OPTIONS,
  previewThemeForScheme,
  resolveTerminalTheme,
  terminalSwatchColors
} from '../../lib/terminalColorSchemes'
import {
  terminalFontWeightLabel,
  terminalFontPresetLabel,
  terminalSchemeLabel,
  useT
} from '../../lib/i18n'
import { TERMINAL_FONT_PRESETS, matchTerminalFontPreset, previewFamilyForFont, primaryFontName } from '../../lib/terminalFonts'
import { useLocaleStore } from '../../store/localeStore'
import { useThemeStore } from '../../store/themeStore'
import { useTerminalAppearanceStore } from '../../store/terminalAppearanceStore'
import {
  TERMINAL_FONT_WEIGHTS,
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT,
  xtermFontWeight,
  type TerminalAppearanceSettings,
  type TerminalColorSchemeId,
  type TerminalFontWeight
} from '../../../shared/terminalSettings'

interface Props {
  onClose: () => void
}

function ColorSwatch({ colors }: { colors: string[] }): JSX.Element {
  return (
    <span className="terminal-scheme-swatch" aria-hidden>
      {colors.map((c, i) => (
        <span key={i} className="terminal-scheme-swatch-cell" style={{ background: c }} />
      ))}
    </span>
  )
}

function TerminalPreview({
  theme,
  fontFamily,
  fontSize,
  lineHeight,
  fontWeight
}: {
  theme: ITheme
  fontFamily: string
  fontSize: number
  lineHeight: number
  fontWeight: TerminalFontWeight
}): JSX.Element {
  const fg = theme.foreground ?? '#ccc'
  const style = {
    background: theme.background ?? '#000',
    color: fg,
    fontFamily,
    fontSize: `${fontSize}px`,
    lineHeight,
    fontWeight: xtermFontWeight(fontWeight)
  } as const

  return (
    <div className="terminal-preview" style={style}>
      <div>
        <span style={{ color: theme.blue }}>user@host</span>
        <span style={{ color: fg }}>:</span>
        <span style={{ color: theme.cyan }}>~</span>
        <span style={{ color: fg }}>$ </span>
        <span style={{ color: fg }}>ls -la</span>
      </div>
      <div>
        <span style={{ color: theme.green }}>drwxr-xr-x</span>
        <span style={{ color: fg }}>  4 user  staff   128 Jun 27 10:00 </span>
        <span style={{ color: theme.blue }}>projects</span>
      </div>
      <div>
        <span style={{ color: theme.green }}>-rw-r--r--</span>
        <span style={{ color: fg }}>  1 user  staff  2048 Jun 27 09:30 </span>
        <span style={{ color: fg }}>README.md</span>
      </div>
      <div>
        <span style={{ color: fg }}>grep </span>
        <span style={{ color: theme.yellow }}>&quot;error&quot;</span>
        <span style={{ color: fg }}> app.log</span>
      </div>
      <div>
        <span style={{ color: theme.red }}>ERROR</span>
        <span style={{ color: fg }}>: connection refused</span>
      </div>
      <div>
        <span style={{ color: theme.magenta }}>INFO</span>
        <span style={{ color: fg }}>: retry succeeded</span>
      </div>
      <div className="terminal-preview-prompt">
        <span style={{ color: theme.blue }}>user@host</span>
        <span style={{ color: fg }}>:</span>
        <span style={{ color: theme.cyan }}>~</span>
        <span style={{ color: fg }}>$ </span>
        <span className="terminal-preview-cursor" style={{ background: theme.cursor }} />
      </div>
    </div>
  )
}

function clampNumber(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function formatStepperValue(n: number, decimals: number): string {
  return decimals > 0 ? n.toFixed(decimals) : String(Math.round(n))
}

function StepperNumberInput({
  value,
  min,
  max,
  step,
  decimals,
  onChange
}: {
  value: number
  min: number
  max: number
  step: number
  decimals: number
  onChange: (n: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(() => formatStepperValue(value, decimals))
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setDraft(formatStepperValue(value, decimals))
  }, [value, decimals])

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    []
  )

  const normalize = (n: number): number => {
    const rounded =
      decimals > 0 ? Math.round(n * 10 ** decimals) / 10 ** decimals : Math.round(n)
    return clampNumber(rounded, min, max)
  }

  const commit = (raw: number): void => {
    const next = normalize(raw)
    setDraft(formatStepperValue(next, decimals))
    onChange(next)
  }

  const scheduleCommit = (raw: number): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => commit(raw), 350)
  }

  const stepBy = (delta: number): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const parsed = Number(draft)
    const base = Number.isFinite(parsed) ? parsed : value
    commit(base + delta)
  }

  const atMin = value <= min
  const atMax = value >= max

  return (
    <div className="terminal-stepper">
      <button
        type="button"
        className="terminal-stepper-btn"
        aria-label="decrease"
        disabled={atMin}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => stepBy(-step)}
      >
        −
      </button>
      <input
        type="text"
        inputMode="decimal"
        className="terminal-stepper-input"
        value={draft}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          const parsed = Number(next)
          if (Number.isFinite(parsed)) scheduleCommit(parsed)
        }}
        onBlur={() => {
          if (debounceRef.current) clearTimeout(debounceRef.current)
          const parsed = Number(draft)
          if (Number.isFinite(parsed)) commit(parsed)
          else setDraft(formatStepperValue(value, decimals))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            stepBy(step)
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            stepBy(-step)
          }
        }}
      />
      <button
        type="button"
        className="terminal-stepper-btn"
        aria-label="increase"
        disabled={atMax}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => stepBy(step)}
      >
        +
      </button>
    </div>
  )
}

function FontFamilyPicker({
  value,
  onChange
}: {
  value: string
  onChange: (fontFamily: string) => void
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
        onClick={() => setOpen((v) => !v)}
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
      {open && (
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

function ColorSchemeDropdown({
  value,
  onChange
}: {
  value: TerminalColorSchemeId
  onChange: (id: TerminalColorSchemeId) => void
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
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ColorSwatch colors={terminalSwatchColors(selectedTheme)} />
        <span className="terminal-scheme-trigger-label">{selectedLabel}</span>
        <span className="terminal-scheme-trigger-caret">▾</span>
      </button>
      {open && (
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

function SettingRow({
  label,
  hint,
  onReset,
  resetLabel,
  children
}: {
  label: string
  hint: string
  onReset: () => void
  resetLabel: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="terminal-setting-row">
      <div className="terminal-setting-label">
        <div className="terminal-setting-label-top">
          <span>{label}</span>
          <button
            type="button"
            className="terminal-setting-reset"
            onClick={onReset}
            title={resetLabel}
            aria-label={resetLabel}
          >
            ↺
          </button>
        </div>
        <span className="terminal-setting-hint">{hint}</span>
      </div>
      <div className="terminal-setting-control">{children}</div>
    </div>
  )
}

export default function TerminalAppearanceModal({ onClose }: Props): JSX.Element {
  const t = useT()
  const locale = useLocaleStore((s) => s.locale)
  const appTheme = useThemeStore((s) => s.theme)
  const appearance = useTerminalAppearanceStore()
  const setAppearance = useTerminalAppearanceStore((s) => s.set)
  const resetField = useTerminalAppearanceStore((s) => s.resetField)

  const resolvedTheme = resolveTerminalTheme(appearance.colorScheme, appTheme)

  const patch = (partial: Partial<TerminalAppearanceSettings>): void => {
    void setAppearance(partial)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal-terminal-appearance"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">{t('settings.terminal.title')}</div>
        <div className="modal-body">
          <TerminalPreview
            theme={resolvedTheme}
            fontFamily={appearance.fontFamily}
            fontSize={appearance.fontSize}
            lineHeight={appearance.lineHeight}
            fontWeight={appearance.fontWeight}
          />

          <h3 className="terminal-settings-section">{t('settings.terminal.textSection')}</h3>

          <SettingRow
            label={t('settings.terminal.colorScheme')}
            hint={t('settings.terminal.colorSchemeHint')}
            resetLabel={t('settings.terminal.reset')}
            onReset={() => void resetField('colorScheme')}
          >
            <ColorSchemeDropdown
              value={appearance.colorScheme}
              onChange={(colorScheme) => patch({ colorScheme })}
            />
          </SettingRow>

          <SettingRow
            label={t('settings.terminal.fontFamily')}
            hint={t('settings.terminal.fontFamilyHint')}
            resetLabel={t('settings.terminal.reset')}
            onReset={() => void resetField('fontFamily')}
          >
            <FontFamilyPicker
              value={appearance.fontFamily}
              onChange={(fontFamily) => patch({ fontFamily })}
            />
          </SettingRow>

          <SettingRow
            label={t('settings.terminal.fontSize')}
            hint={t('settings.terminal.fontSizeHint')}
            resetLabel={t('settings.terminal.reset')}
            onReset={() => void resetField('fontSize')}
          >
            <StepperNumberInput
              value={appearance.fontSize}
              min={8}
              max={32}
              step={1}
              decimals={0}
              onChange={(fontSize) => patch({ fontSize })}
            />
          </SettingRow>

          <SettingRow
            label={t('settings.terminal.lineHeight')}
            hint={t('settings.terminal.lineHeightHint')}
            resetLabel={t('settings.terminal.reset')}
            onReset={() => void resetField('lineHeight')}
          >
            <StepperNumberInput
              value={appearance.lineHeight}
              min={MIN_TERMINAL_LINE_HEIGHT}
              max={MAX_TERMINAL_LINE_HEIGHT}
              step={0.05}
              decimals={2}
              onChange={(lineHeight) => patch({ lineHeight })}
            />
          </SettingRow>

          <SettingRow
            label={t('settings.terminal.fontWeight')}
            hint={t('settings.terminal.fontWeightHint')}
            resetLabel={t('settings.terminal.reset')}
            onReset={() => void resetField('fontWeight')}
          >
            <select
              value={appearance.fontWeight}
              onChange={(e) => patch({ fontWeight: e.target.value as TerminalFontWeight })}
            >
              {TERMINAL_FONT_WEIGHTS.map((w) => (
                <option key={w} value={w}>
                  {terminalFontWeightLabel(locale, w)}
                </option>
              ))}
            </select>
          </SettingRow>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
