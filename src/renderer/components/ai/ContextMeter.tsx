import { formatTokenCount } from '../../../shared/contextBudget'
import type { ChatPayloadBudget } from '../../../shared/contextBudget'
import { useT } from '../../lib/i18n'

interface Props {
  budget: ChatPayloadBudget
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
  const pct = Math.min(100, Math.round(budget.usageRatio * 100))
  const level = usageLevel(budget.usageRatio)
  const usedLabel = formatTokenCount(budget.breakdown.total)
  const limitLabel = formatTokenCount(budget.limit)
  const usedArc = (pct / 100) * PIE_C
  const title = t('copilot.context.meterTitle', {
    used: usedLabel,
    limit: limitLabel,
    pct
  })

  return (
    <div className={`context-meter context-meter--${level}`} title={title}>
      <svg
        className="context-meter-pie"
        width={PIE_SIZE}
        height={PIE_SIZE}
        viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}
        role="img"
        aria-label={title}
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
    </div>
  )
}
