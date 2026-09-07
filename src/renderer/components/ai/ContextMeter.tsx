import { useRef, useState } from 'react'
import { formatTokenCount } from '../../../shared/contextBudget'
import type { DetailedContextBreakdown } from '../../../shared/contextBudget'
import { useT } from '../../lib/i18n'
import ContextBreakdownPopover from './ContextBreakdownPopover'

interface Props {
  budget: DetailedContextBreakdown
}

function usageLevel(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio >= 0.8) return 'danger'
  if (ratio >= 0.6) return 'warn'
  return 'ok'
}

const PIE_SIZE = 28
const PIE_R = 12
const PIE_C = 2 * Math.PI * PIE_R

export default function ContextMeter({ budget }: Props): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pct = Math.min(100, Math.round(budget.usageRatio * 100))
  const level = usageLevel(budget.usageRatio)
  const usedLabel = formatTokenCount(budget.total)
  const limitLabel = formatTokenCount(budget.limit)
  const title = t('copilot.context.meterTitle', {
    used: usedLabel,
    limit: limitLabel,
    pct
  })
  const usedArc = (pct / 100) * PIE_C

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`context-meter context-meter--${level}${open ? ' is-open' : ''}`}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <svg
          className="context-meter-pie"
          width={PIE_SIZE}
          height={PIE_SIZE}
          viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}
          role="img"
          aria-hidden
        >
          <circle
            className="context-meter-pie-track"
            cx={PIE_SIZE / 2}
            cy={PIE_SIZE / 2}
            r={PIE_R}
            fill="none"
            strokeWidth="4"
          />
          {pct > 0 && (
            <circle
              className="context-meter-pie-used"
              cx={PIE_SIZE / 2}
              cy={PIE_SIZE / 2}
              r={PIE_R}
              fill="none"
              strokeWidth="4"
              strokeDasharray={`${usedArc} ${PIE_C}`}
              strokeLinecap="round"
              transform={`rotate(-90 ${PIE_SIZE / 2} ${PIE_SIZE / 2})`}
            />
          )}
          <text
            className="context-meter-pie-label"
            x={PIE_SIZE / 2}
            y={PIE_SIZE / 2}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {pct}%
          </text>
        </svg>
        <span className="context-meter-caption" aria-hidden>
          {usedLabel}/{limitLabel}
        </span>
      </button>
      <ContextBreakdownPopover
        open={open}
        breakdown={budget}
        triggerRef={triggerRef}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
