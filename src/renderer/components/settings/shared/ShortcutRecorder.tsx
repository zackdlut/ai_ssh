import { useEffect, useState } from 'react'
import { keyEventToBinding } from '../../../lib/keybindingMatch'
import { formatShortcut } from '../../../lib/shortcuts'
import { useT } from '../../../lib/i18n'

interface Props {
  value: string
  onChange: (spec: string) => void
}

export default function ShortcutRecorder({ value, onChange }: Props): JSX.Element {
  const t = useT()
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return

    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setRecording(false)
        return
      }

      const spec = keyEventToBinding(e)
      if (spec) {
        onChange(spec)
        setRecording(false)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, onChange])

  return (
    <button
      type="button"
      className={`shortcut-recorder${recording ? ' is-recording' : ''}`}
      onClick={() => setRecording(true)}
      aria-pressed={recording}
    >
      {recording ? t('settings.shortcuts.pressKey') : formatShortcut(value)}
    </button>
  )
}
