import {
  TerminalPreview,
  ColorSchemeDropdown,
  FontFamilyPicker,
  StepperNumberInput,
  SettingRow
} from '../settings/shared'
import { resolveTerminalTheme } from '../../lib/terminalColorSchemes'
import { terminalFontWeightLabel, useT } from '../../lib/i18n'
import { useLocaleStore } from '../../store/localeStore'
import { useThemeStore } from '../../store/themeStore'
import { useTerminalAppearanceStore } from '../../store/terminalAppearanceStore'
import {
  TERMINAL_FONT_WEIGHTS,
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT,
  type TerminalAppearanceSettings,
  type TerminalFontWeight
} from '../../../shared/terminalSettings'

interface Props {
  onClose: () => void
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
