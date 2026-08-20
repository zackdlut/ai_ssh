/**
 * Structured task plan for the agent loop.
 *
 * The system prompt used to ask the model to "state a brief numbered plan"
 * as prose. That plan was invisible to the harness: it scrolled away, it was
 * the first thing dropped by history compression, and nothing re-stated it on
 * later turns — so by step 8 the model no longer knew what step 2 had promised.
 * Making the plan a tool-maintained structure fixes all three: it is stored per
 * chat, re-injected verbatim every turn, and rendered as live progress.
 */
import { useAIStore } from '../store/aiStore'
import type { PlanItem, PlanItemStatus } from '../../shared/types'
import type { ToolResult } from './fileTools'

const MAX_PLAN_ITEMS = 20
const TITLE_MAX = 120

const STATUSES: PlanItemStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

function isStatus(v: unknown): v is PlanItemStatus {
  return typeof v === 'string' && (STATUSES as string[]).includes(v)
}

function statusMark(status: PlanItemStatus): string {
  switch (status) {
    case 'completed':
      return '[x]'
    case 'in_progress':
      return '[>]'
    case 'cancelled':
      return '[-]'
    default:
      return '[ ]'
  }
}

/**
 * Replace the plan for a chat. The model always sends the complete list, so a
 * partial update cannot silently drop steps: whatever it omits is genuinely
 * gone from the plan.
 */
export function updatePlan(chatTabId: string | undefined, args: Record<string, unknown>): ToolResult {
  if (!chatTabId) return { ok: false, error: 'No active chat to attach a plan to.' }
  const raw = args.items
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'items must be an array of { title, status } objects.' }
  }
  if (raw.length === 0) {
    useAIStore.getState().setPlan(chatTabId, [])
    return { ok: true, result: 'Plan cleared.' }
  }
  if (raw.length > MAX_PLAN_ITEMS) {
    return {
      ok: false,
      error: `A plan may have at most ${MAX_PLAN_ITEMS} steps; ${raw.length} were given. Group the work into fewer, larger steps.`
    }
  }

  const items: PlanItem[] = []
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `items[${i}] is not an object.` }
    }
    const { title, status } = entry as { title?: unknown; status?: unknown }
    if (typeof title !== 'string' || !title.trim()) {
      return { ok: false, error: `items[${i}].title must be a non-empty string.` }
    }
    if (!isStatus(status)) {
      return {
        ok: false,
        error: `items[${i}].status must be one of ${STATUSES.join(', ')}.`
      }
    }
    items.push({
      id: `${i + 1}`,
      title: title.trim().slice(0, TITLE_MAX),
      status
    })
  }

  const inProgress = items.filter((i) => i.status === 'in_progress').length
  if (inProgress > 1) {
    return {
      ok: false,
      error: `${inProgress} steps are marked in_progress. Exactly one step may be in progress at a time.`
    }
  }

  useAIStore.getState().setPlan(chatTabId, items)

  const done = items.filter((i) => i.status === 'completed').length
  return {
    ok: true,
    result: `Plan updated (${done}/${items.length} completed).\n${items
      .map((i, idx) => `${idx + 1}. ${statusMark(i.status)} ${i.title}`)
      .join('\n')}`
  }
}

/**
 * Render the current plan for injection into the turn. Returns undefined when
 * no plan exists so an empty section is never added to the context.
 */
export function buildPlanContextMessage(chatTabId: string | undefined): string | undefined {
  if (!chatTabId) return undefined
  const plan = useAIStore.getState().chatTabs.find((t) => t.id === chatTabId)?.plan
  if (!plan || plan.length === 0) return undefined

  const lines = plan.map((item, idx) => `${idx + 1}. ${statusMark(item.status)} ${item.title}`)
  const remaining = plan.filter((i) => i.status === 'pending' || i.status === 'in_progress').length
  const tail =
    remaining === 0
      ? 'Every step is resolved. Report the outcome and stop unless the user asks for more.'
      : 'Keep working through the remaining steps. Call update_plan again as each one completes; do NOT wait for the user to tell you to continue.'

  return `Current task plan (maintained by you via update_plan):
${lines.join('\n')}

${tail}`
}
