import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CopilotAgentMode } from '../../../shared/types'
import { useT, type TranslationKey } from '../../lib/i18n'
import UiIcon from '../UiIcon'

interface Props {
  value: CopilotAgentMode
  disabled?: boolean
  onChange: (mode: CopilotAgentMode) => void
}

/** Default (Agent) first, matching Cursor's mode menu. */
const MODES: readonly CopilotAgentMode[] = ['agent', 'plan', 'execute']

const DESC_KEY: Record<CopilotAgentMode, TranslationKey> = {
  agent: 'copilot.mode.agentDesc',
  plan: 'copilot.mode.planDesc',
  execute: 'copilot.mode.executeDesc'
}

const LABEL_KEY: Record<CopilotAgentMode, TranslationKey> = {
  agent: 'copilot.mode.agent',
  plan: 'copilot.mode.plan',
  execute: 'copilot.mode.execute'
}

const MENU_WIDTH = 268

export default function ModeSelect({ value, disabled, onChange }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const t = useT()

  const updateMenuPosition = (): void => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    let left = rect.left
    if (left + MENU_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - MENU_WIDTH - 8)
    }
    if (left < 8) left = 8
    setMenuStyle({
      position: 'fixed',
      left,
      bottom: window.innerHeight - rect.top + 6,
      width: MENU_WIDTH
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    updateMenuPosition()
  }, [open, value])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const close = (): void => setOpen(false)
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [open])

  const pick = (mode: CopilotAgentMode): void => {
    if (mode !== value) onChange(mode)
    setOpen(false)
  }

  const menu =
    open &&
    createPortal(
      <div
        ref={menuRef}
        className="composer-mode-menu"
        role="listbox"
        aria-label={t('copilot.mode.group')}
        style={menuStyle}
      >
        {MODES.map((mode) => {
          const active = mode === value
          return (
            <button
              key={mode}
              type="button"
              role="option"
              aria-selected={active}
              className={`composer-mode-option composer-mode-option--${mode}${active ? ' is-on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(mode)}
            >
              <span className="composer-mode-option-row">
                <span className="composer-mode-option-name">{t(LABEL_KEY[mode])}</span>
                {active && (
                  <span className="composer-mode-option-check" aria-hidden>
                    ✓
                  </span>
                )}
              </span>
              <span className="composer-mode-option-desc">{t(DESC_KEY[mode])}</span>
            </button>
          )
        })}
      </div>,
      document.body
    )

  return (
    <div className={`composer-mode-wrap composer-mode-wrap--${value}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-mode-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('copilot.mode.group')}
        onClick={(e) => {
          e.stopPropagation()
          if (!disabled) setOpen((v) => !v)
        }}
      >
        <span className="composer-mode-trigger-label">{t(LABEL_KEY[value])}</span>
        <UiIcon
          name="caret-down"
          size="sm"
          className={`composer-mode-caret ${open ? 'open' : ''}`}
        />
      </button>
      {menu}
    </div>
  )
}
