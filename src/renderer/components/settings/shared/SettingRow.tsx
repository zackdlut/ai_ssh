import type { ReactNode } from 'react'

export default function SettingRow({
  label,
  hint,
  onReset,
  resetLabel,
  children,
  changed = false
}: {
  label: string
  hint?: string
  onReset?: () => void
  resetLabel?: string
  children: ReactNode
  changed?: boolean
}): JSX.Element {
  return (
    <div className={`terminal-setting-row${changed ? ' tool-settings-changed' : ''}`}>
      <div className="terminal-setting-label">
        <div className="terminal-setting-label-top">
          <span>{label}</span>
          {onReset && resetLabel && (
            <button
              type="button"
              className="terminal-setting-reset"
              onClick={onReset}
              title={resetLabel}
              aria-label={resetLabel}
            >
              ↺
            </button>
          )}
        </div>
        {hint && <span className="terminal-setting-hint">{hint}</span>}
      </div>
      <div className="terminal-setting-control">{children}</div>
    </div>
  )
}
