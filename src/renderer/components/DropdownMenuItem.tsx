import type { ReactNode } from 'react'
import UiIcon, { type UiIconName } from './UiIcon'

interface Props {
  children: ReactNode
  icon?: UiIconName
  /** Longer explanation, for items whose label cannot carry it. */
  title?: string
  onClick?: () => void
  disabled?: boolean
}

export default function DropdownMenuItem({
  children,
  icon,
  title,
  onClick,
  disabled
}: Props): JSX.Element {
  return (
    <button
      type="button"
      className="toolbar-dropdown-item"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {icon ? <UiIcon name={icon} tone="menu" className="menu-item-icon" /> : null}
      <span className="menu-item-label">{children}</span>
    </button>
  )
}
