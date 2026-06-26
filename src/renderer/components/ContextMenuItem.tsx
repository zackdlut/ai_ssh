import type { ReactNode } from 'react'
import { formatShortcut } from '../lib/shortcuts'

interface Props {
  children: ReactNode
  /** Shortcut spec, e.g. `mod+c` → Ctrl+C / ⌘C */
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
}

export default function ContextMenuItem({
  children,
  shortcut,
  onClick,
  disabled
}: Props): JSX.Element {
  return (
    <button type="button" className="context-menu-item" onClick={onClick} disabled={disabled}>
      <span className="context-menu-label">{children}</span>
      {shortcut ? (
        <span className="context-menu-shortcut" aria-hidden>
          {formatShortcut(shortcut)}
        </span>
      ) : null}
    </button>
  )
}
