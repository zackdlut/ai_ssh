import { useRef, useState, type ReactNode } from 'react'
import UiIcon, { type UiIconName } from './UiIcon'

interface Props {
  children: ReactNode
  label: ReactNode
  icon?: UiIconName
  title?: string
  disabled?: boolean
}

/**
 * A context-menu row that opens a nested panel of choices.
 *
 * Kept as its own component because the alternative for a list like the baud
 * rates is to flatten it into the parent menu, which turns a five-item menu
 * into a fifteen-item one and buries the actions the user reaches for daily.
 *
 * Opens on hover AND on click: hover is what a mouse user expects from a menu,
 * while click is what keeps it usable for touch and for anyone who arrives by
 * keyboard. It does not close on mouse-out of the parent row alone, since the
 * pointer has to cross that row's edge to reach the panel.
 */
export default function ContextMenuSubmenu({
  children,
  label,
  icon,
  title,
  disabled
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  // Which side the panel opens toward. The sidebar sits at the left edge, so
  // right is almost always correct — but a menu opened near the right edge of
  // a narrow window would otherwise put the panel off screen.
  const [flip, setFlip] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  const show = (): void => {
    if (disabled) return
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) setFlip(rect.right + PANEL_WIDTH > window.innerWidth)
    setOpen(true)
  }

  return (
    <div
      ref={rowRef}
      className={`context-submenu ${open ? 'open' : ''}`}
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="context-menu-item"
        title={title}
        disabled={disabled}
        // The row itself performs nothing, so a click only reveals the panel —
        // and must not reach the window listener that dismisses the whole menu.
        onClick={(e) => {
          e.stopPropagation()
          show()
        }}
      >
        {icon ? <UiIcon name={icon} tone="menu" className="menu-item-icon" /> : null}
        <span className="context-menu-label">{label}</span>
        <span className="context-submenu-caret" aria-hidden>
          ▸
        </span>
      </button>
      {open && (
        <div className={`context-submenu-panel ${flip ? 'flip' : ''}`}>{children}</div>
      )}
    </div>
  )
}

/** Kept in sync with `.context-submenu-panel` min-width in the stylesheet. */
const PANEL_WIDTH = 180
