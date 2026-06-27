import type { ReactNode } from 'react'
import UiIcon, { type UiIconName } from './UiIcon'

interface Props {
  children: ReactNode
  icon?: UiIconName
  onClick?: () => void
  disabled?: boolean
}

export default function DropdownMenuItem({
  children,
  icon,
  onClick,
  disabled
}: Props): JSX.Element {
  return (
    <button type="button" className="toolbar-dropdown-item" onClick={onClick} disabled={disabled}>
      {icon ? <UiIcon name={icon} className="menu-item-icon" /> : null}
      <span className="menu-item-label">{children}</span>
    </button>
  )
}
