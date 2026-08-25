import { SettingRow, ShortcutRecorder } from './shared'
import { useT } from '../../lib/i18n'
import { useKeybindingsStore } from '../../store/keybindingsStore'
import { KEYBINDING_IDS, type KeybindingId } from '../../../shared/keybindings'

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
          {KEYBINDING_IDS.map((id) => (
            <SettingRow
              key={id}
              label={t(`settings.shortcuts.${id}`)}
              hint={t(`settings.shortcuts.${id}Hint`)}
              resetLabel={t('settings.shortcuts.reset')}
              onReset={() => void resetKeybinding(id)}
            >
              <ShortcutRecorder
                value={keybindings[id]}
                onChange={(spec) => patchKeybinding(id, spec)}
              />
            </SettingRow>
          ))}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
