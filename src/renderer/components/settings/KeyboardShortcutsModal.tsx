import { SettingRow, ShortcutRecorder } from './shared'
import { useT } from '../../lib/i18n'
import { useKeybindingsStore } from '../../store/keybindingsStore'
import type { KeybindingId } from '../../../shared/keybindings'

interface Props {
  onClose: () => void
}

export default function KeyboardShortcutsModal({ onClose }: Props): JSX.Element {
  const t = useT()
  const keybindings = useKeybindingsStore()
  const setKeybinding = useKeybindingsStore((s) => s.set)
  const resetKeybinding = useKeybindingsStore((s) => s.resetField)

  const patchKeybinding = (id: KeybindingId, spec: string): void => {
    void setKeybinding({ [id]: spec })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-keyboard-shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{t('settings.shortcuts.title')}</div>
        <div className="modal-body">
          <SettingRow
            label={t('settings.shortcuts.askCopilot')}
            hint={t('settings.shortcuts.askCopilotHint')}
            resetLabel={t('settings.shortcuts.reset')}
            onReset={() => void resetKeybinding('askCopilot')}
          >
            <ShortcutRecorder
              value={keybindings.askCopilot}
              onChange={(spec) => patchKeybinding('askCopilot', spec)}
            />
          </SettingRow>

          <SettingRow
            label={t('settings.shortcuts.toggleNlMode')}
            hint={t('settings.shortcuts.toggleNlModeHint')}
            resetLabel={t('settings.shortcuts.reset')}
            onReset={() => void resetKeybinding('toggleNlMode')}
          >
            <ShortcutRecorder
              value={keybindings.toggleNlMode}
              onChange={(spec) => patchKeybinding('toggleNlMode', spec)}
            />
          </SettingRow>

          <SettingRow
            label={t('settings.shortcuts.toggleLineNumbers')}
            hint={t('settings.shortcuts.toggleLineNumbersHint')}
            resetLabel={t('settings.shortcuts.reset')}
            onReset={() => void resetKeybinding('toggleLineNumbers')}
          >
            <ShortcutRecorder
              value={keybindings.toggleLineNumbers}
              onChange={(spec) => patchKeybinding('toggleLineNumbers', spec)}
            />
          </SettingRow>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
