import { useState } from 'react'
import { useAIStore } from '../../store/aiStore'
import { useT } from '../../lib/i18n'
import type { PlanItem } from '../../../shared/types'

function isOpen(item: PlanItem): boolean {
  return item.status === 'pending' || item.status === 'in_progress'
}

/**
 * Live progress for the agent's task plan (maintained by the `update_plan`
 * tool). Rendered outside the message list so a long task's plan stays visible
 * instead of scrolling away behind dozens of tool cards.
 */
export default function PlanCard(): JSX.Element | null {
  const plan = useAIStore((s) => s.chatTabs.find((t) => t.id === s.activeChatTabId)?.plan)
  const [collapsed, setCollapsed] = useState(false)
  const t = useT()

  if (!plan || plan.length === 0) return null

  const done = plan.filter((i) => i.status === 'completed').length
  const current = plan.find((i) => i.status === 'in_progress')
  const allResolved = plan.every((i) => !isOpen(i))

  return (
    <div className={`plan-card${allResolved ? ' plan-card--done' : ''}`}>
      <button
        type="button"
        className="plan-card-header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="plan-card-caret" aria-hidden>
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="plan-card-title">{t('copilot.plan.title')}</span>
        <span className="plan-card-count">
          {done}/{plan.length}
        </span>
        {collapsed && current && <span className="plan-card-current">{current.title}</span>}
      </button>
      {!collapsed && (
        <ol className="plan-card-list">
          {plan.map((item) => (
            <li key={item.id} className={`plan-item plan-item--${item.status}`}>
              <span className="plan-item-mark" aria-hidden>
                {item.status === 'completed'
                  ? '✓'
                  : item.status === 'in_progress'
                    ? '●'
                    : item.status === 'cancelled'
                      ? '✕'
                      : '○'}
              </span>
              <span className="plan-item-text">{item.title}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
