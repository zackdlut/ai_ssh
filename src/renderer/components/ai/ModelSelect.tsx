import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MODEL_PROFILES, resolveModel, DEFAULT_CONTEXT_LENGTHS } from '../../../shared/aiSettings'
import type { ModelProfile } from '../../../shared/types'
import { modelProfileLabel, useT, type AppLocale } from '../../lib/i18n'

interface Props {
  value: ModelProfile
  modelNames: Record<ModelProfile, string>
  locale: AppLocale
  disabled?: boolean
  onChange: (profile: ModelProfile) => void
}

const MENU_WIDTH = 220

export default function ModelSelect({
  value,
  modelNames,
  locale,
  disabled,
  onChange
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const t = useT()

  const settings = {
    baseURL: '',
    apiKey: '',
    copilotModelProfile: value,
    nlModelProfile: 'fast' as const,
    models: modelNames,
    contextLengths: { ...DEFAULT_CONTEXT_LENGTHS }
  }
  const activeModelName = resolveModel(settings, value)

  const updateMenuPosition = (): void => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuWidth = rect.width || MENU_WIDTH
    let left = rect.left
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - menuWidth - 8)
    }
    setMenuStyle({
      position: 'fixed',
      left,
      bottom: window.innerHeight - rect.top + 6,
      width: menuWidth
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    updateMenuPosition()
  }, [open, value, activeModelName])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const close = (): void => setOpen(false)
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [open])

  const pick = (profile: ModelProfile): void => {
    onChange(profile)
    setOpen(false)
  }

  const menu =
    open &&
    createPortal(
      <div
        ref={menuRef}
        className="model-select-menu"
        role="listbox"
        aria-label={t('copilot.modelSelect')}
        style={menuStyle}
      >
        {MODEL_PROFILES.map((p) => {
          const name = resolveModel(settings, p.id)
          const active = p.id === value
          return (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={active}
              className={`model-select-option ${active ? 'active' : ''}`}
              onClick={() => pick(p.id)}
            >
              <span className="model-select-option-tier">{modelProfileLabel(locale, p.id)}</span>
              <span className="model-select-option-name">{name}</span>
            </button>
          )
        })}
      </div>,
      document.body
    )

  return (
    <div className="model-select-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`model-select-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={activeModelName}
        onClick={(e) => {
          e.stopPropagation()
          if (!disabled) setOpen((v) => !v)
        }}
      >
        <span className="model-select-line">
          <span className="model-select-tier">{modelProfileLabel(locale, value)}</span>
          <span className="model-select-sep" aria-hidden>
            ·
          </span>
          <span className="model-select-name">{activeModelName}</span>
        </span>
        <span className={`model-select-caret ${open ? 'open' : ''}`} aria-hidden>
          ▴
        </span>
      </button>
      {menu}
    </div>
  )
}
