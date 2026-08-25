import type { ReactNode } from 'react'
import { formatShortcut } from '../lib/shortcuts'
import UiIcon, { type UiIconName } from './UiIcon'

interface Props {
  children: ReactNode
  icon?: UiIconName
  iconSize?: 'sm' | 'md' | 'lg'
  /** Shortcut spec, e.g. `mod+c` → Ctrl+C / ⌘C */
  shortcut?: string
  /** Longer explanation, for items whose label cannot carry it. */
  title?: string
  onClick?: () => void
  disabled?: boolean
}

export default function ContextMenuItem({
  children,
  icon,
  iconSize,
  shortcut,
  title,
  onClick,
  disabled
}: Props): JSX.Element {
  return (
    <button
      type="button"
      className="context-menu-item"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {icon ? (
        <UiIcon name={icon} size={iconSize} tone="menu" className="menu-item-icon" />
      ) : null}
      <span className="context-menu-label">{children}</span>
      {shortcut ? (
        <span className="context-menu-shortcut" aria-hidden>
          {formatShortcut(shortcut)}
        </span>
      ) : null}
    </button>
  )
}
