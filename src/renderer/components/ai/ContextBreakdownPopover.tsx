import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatTokenCount } from '../../../shared/contextBudget'
import type { DetailedContextBreakdown } from '../../../shared/contextBudget'
import { useT, type TranslationKey } from '../../lib/i18n'

interface Props {
  open: boolean
  breakdown: DetailedContextBreakdown
  onClose: () => void
  triggerRef: React.RefObject<HTMLElement>
}

const POPOVER_WIDTH = 280

type RowKey =
  | 'system'
  | 'terminal'
  | 'tools'
  | 'injections'
  | 'history'
  | 'draft'

const ROW_KEYS: RowKey[] = ['system', 'terminal', 'tools', 'injections', 'history', 'draft']

const ROW_LABELS: Record<RowKey, TranslationKey> = {
  system: 'copilot.context.breakdown.system',
  terminal: 'copilot.context.breakdown.terminal',
  tools: 'copilot.context.breakdown.tools',
  injections: 'copilot.context.breakdown.injections',
  history: 'copilot.context.breakdown.history',
  draft: 'copilot.context.breakdown.draft'
}

const ROW_ACCENTS: Record<RowKey, string> = {
  system: 'var(--text-dim)',
  terminal: 'var(--azure)',
  tools: 'var(--violet)',
  injections: 'var(--warn)',
  history: 'var(--signal)',
  draft: 'var(--ok)'
}

function usageLevel(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio >= 0.8) return 'danger'
  if (ratio >= 0.6) return 'warn'
  return 'ok'
}

export default function ContextBreakdownPopover({
  open,
  breakdown,
  onClose,
  triggerRef
}: Props): JSX.Element | null {
  const t = useT()
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})

  const updateMenuPosition = (): void => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    let left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2
    if (left < 8) left = 8
    if (left + POPOVER_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - POPOVER_WIDTH - 8)
    }
    setMenuStyle({
      position: 'fixed',
      left,
      bottom: window.innerHeight - rect.top + 6,
      width: POPOVER_WIDTH
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    updateMenuPosition()
  }, [open, breakdown.total, breakdown.limit])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      onClose()
    }
    const close = (): void => onClose()
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
  }, [open, onClose, triggerRef])

  if (!open) return null

  const limit = breakdown.limit > 0 ? breakdown.limit : 1
  const level = usageLevel(breakdown.usageRatio)
  const pct = Math.min(100, Math.round(breakdown.usageRatio * 100))
  const activeRows = ROW_KEYS.filter((key) => breakdown[key] > 0)

  return createPortal(
    <div
      ref={menuRef}
      className={`context-breakdown-popover context-breakdown-popover--${level}`}
      role="dialog"
      aria-label={t('copilot.context.breakdown.title')}
      style={menuStyle}
    >
      <div className="context-breakdown-head">
        <div className="context-breakdown-head-copy">
          <span className="context-breakdown-title">{t('copilot.context.breakdown.title')}</span>
          <span className="context-breakdown-total">
            {formatTokenCount(breakdown.total)} / {formatTokenCount(breakdown.limit)}
          </span>
        </div>
        <span className="context-breakdown-pct" aria-hidden>{pct}%</span>
      </div>
      {activeRows.length > 0 && (
        <div className="context-breakdown-stack" aria-hidden>
          {activeRows.map((key) => {
            const width = Math.max(0.8, (breakdown[key] / limit) * 100)
            return (
              <span
                key={key}
                className="context-breakdown-stack-seg"
                style={{ width: `${width}%`, background: ROW_ACCENTS[key] }}
                title={t(ROW_LABELS[key])}
              />
            )
          })}
        </div>
      )}
      <ul className="context-breakdown-list">
        {activeRows.map((key) => {
          const tokens = breakdown[key]
          const rowPct = Math.round((tokens / limit) * 100)
          const barPct = Math.min(100, (tokens / limit) * 100)
          return (
            <li key={key} className="context-breakdown-row">
              <div className="context-breakdown-row-head">
                <span className="context-breakdown-label">
                  <span
                    className="context-breakdown-swatch"
                    style={{ background: ROW_ACCENTS[key] }}
                    aria-hidden
                  />
                  {t(ROW_LABELS[key])}
                </span>
                <span className="context-breakdown-count">
                  <span className="context-breakdown-tokens">{formatTokenCount(tokens)}</span>
                  <span className="context-breakdown-pct-inline">{rowPct}%</span>
                </span>
              </div>
              <div className="context-breakdown-bar" aria-hidden>
                <span
                  className="context-breakdown-bar-fill"
                  style={{ width: `${barPct}%`, background: ROW_ACCENTS[key] }}
                />
              </div>
            </li>
          )
        })}
      </ul>
      {breakdown.outputReserve > 0 && (
        <p className="context-breakdown-footnote">
          {t('copilot.context.breakdown.outputReserve', {
            count: formatTokenCount(breakdown.outputReserve)
          })}
        </p>
      )}
    </div>,
    document.body
  )
}
