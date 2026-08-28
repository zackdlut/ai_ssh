import { useState } from 'react'
import { useAIStore } from '../../store/aiStore'
import { useT } from '../../lib/i18n'
import { sendPrompt } from '../../lib/aiService'
import { restoreRemoteBackup } from '../../lib/fileTools'
import { shortCheckpointPath } from '../../lib/fileCheckpoints'
import { planGroupSizes } from '../../lib/planTool'
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
  const tab = useAIStore((s) => s.chatTabs.find((t) => t.id === s.activeChatTabId))
  const setAgentMode = useAIStore((s) => s.setAgentMode)
  const setNotice = useAIStore((s) => s.setNotice)
  const [collapsed, setCollapsed] = useState(false)
  const t = useT()

  const plan = tab?.plan
  const checkpoints = tab?.checkpoints ?? []
  if ((!plan || plan.length === 0) && checkpoints.length === 0) return null

  const done = plan?.filter((i) => i.status === 'completed').length ?? 0
  const running = plan?.filter((i) => i.status === 'in_progress') ?? []
  // Collapsed, a parallel group has no single "current step" to name, and
  // picking the first would hide that two others are also running.
  const currentLabel =
    running.length > 1
      ? t('copilot.plan.parallelRunning', { count: running.length })
      : running[0]?.title
  const allResolved = !plan || plan.length === 0 || plan.every((i) => !isOpen(i))
  const groupSizes = planGroupSizes(plan ?? [])
  const showExecute = (tab?.agentMode ?? 'agent') === 'plan' && !!plan && plan.length > 0

  const implement = (): void => {
    if (!tab) return
    setAgentMode(tab.id, 'execute')
    void sendPrompt(t('copilot.plan.executePrompt'), tab.id)
  }

  const restore = async (id: string): Promise<void> => {
    const cp = checkpoints.find((c) => c.id === id)
    if (!cp) {
      setNotice(t('copilot.restore.missing'))
      return
    }
    const result = await restoreRemoteBackup({
      terminalTabId: cp.terminalTabId,
      path: cp.path,
      backupPath: cp.backupPath
    })
    if (result.ok) setNotice(t('copilot.restore.ok', { path: cp.path }))
    else setNotice(t('copilot.restore.fail', { error: result.error }))
  }

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
        {plan && plan.length > 0 && (
          <span className="plan-card-count">
            {done}/{plan.length}
          </span>
        )}
        {collapsed && currentLabel && <span className="plan-card-current">{currentLabel}</span>}
      </button>
      {!collapsed && plan && plan.length > 0 && (
        <ol className="plan-card-list">
          {plan.map((item, idx) => {
            const size = item.group === undefined ? 1 : (groupSizes.get(item.group) ?? 1)
            const parallel = size > 1
            // Adjacency, not "every step with this group number": the model
            // sends the step order, and gathering a scattered group would show
            // a plan nobody wrote. A non-adjacent group renders as two blocks,
            // which is honest about what was declared.
            const opensGroup = parallel && plan[idx - 1]?.group !== item.group
            return (
              <li
                key={item.id}
                className={`plan-item plan-item--${item.status}${
                  parallel ? ' plan-item--parallel' : ''
                }`}
              >
                <span className="plan-item-mark" aria-hidden>
                  {item.status === 'completed'
                    ? '✓'
                    : item.status === 'in_progress'
                      ? '●'
                      : item.status === 'cancelled'
                        ? '✕'
                        : '○'}
                </span>
                <span className="plan-item-text">
                  {item.title}
                  {opensGroup && (
                    <span className="plan-item-parallel" title={t('copilot.plan.parallelHint')}>
                      {t('copilot.plan.parallel', { count: size })}
                    </span>
                  )}
                  {item.verify && (
                    // The check is the user's handle on whether "done" means
                    // anything: showing it makes an unverified claim visible.
                    <span className="plan-item-verify" title={t('copilot.plan.verifyHint')}>
                      {t('copilot.plan.verify')} <code>{item.verify.command}</code>
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {!collapsed && showExecute && (
        <div className="plan-card-actions">
          <button type="button" className="plan-card-execute" onClick={implement}>
            {t('copilot.plan.execute')}
          </button>
        </div>
      )}
      {!collapsed && checkpoints.length > 0 && (
        <div className="plan-card-checkpoints">
          <div className="plan-card-checkpoints-title">{t('copilot.checkpoint.title')}</div>
          <ul className="plan-card-checkpoint-list">
            {[...checkpoints].reverse().map((cp) => (
              <li key={cp.id} className="plan-card-checkpoint">
                <span className="plan-card-checkpoint-path" title={cp.path}>
                  {shortCheckpointPath(cp.path)}
                </span>
                <button
                  type="button"
                  className="plan-card-restore"
                  onClick={() => void restore(cp.id)}
                >
                  {t('copilot.restore')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
