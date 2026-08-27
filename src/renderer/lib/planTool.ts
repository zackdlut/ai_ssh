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
import type { PlanItem, PlanItemStatus, PlanStepVerify } from '../../shared/types'
import { verifyPlanStep, type ExecEvidence } from '../../shared/planVerify'
import type { ToolResult } from './fileTools'

const MAX_PLAN_ITEMS = 20
const TITLE_MAX = 120
const VERIFY_COMMAND_MAX = 300

const STATUSES: PlanItemStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

function isStatus(v: unknown): v is PlanItemStatus {
  return typeof v === 'string' && (STATUSES as string[]).includes(v)
}

/**
 * Read the optional verify block. A malformed one is rejected rather than
 * dropped: silently discarding it would turn "I declared a check" into "no
 * check exists", which is the exact failure this feature is meant to catch.
 */
function parseVerify(
  raw: unknown,
  index: number
): { ok: true; verify?: PlanStepVerify } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'object') {
    return { ok: false, error: `items[${index}].verify must be an object with a command.` }
  }
  const { command, expect_exit_code: exitCode, expect_output: output } = raw as {
    command?: unknown
    expect_exit_code?: unknown
    expect_output?: unknown
  }
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: `items[${index}].verify.command must be a non-empty string.` }
  }
  if (exitCode !== undefined && !Number.isInteger(exitCode)) {
    return { ok: false, error: `items[${index}].verify.expect_exit_code must be an integer.` }
  }
  if (output !== undefined && typeof output !== 'string') {
    return { ok: false, error: `items[${index}].verify.expect_output must be a regular expression string.` }
  }
  if (typeof output === 'string') {
    try {
      new RegExp(output)
    } catch {
      return {
        ok: false,
        error: `items[${index}].verify.expect_output is not a valid regular expression.`
      }
    }
  }
  return {
    ok: true,
    verify: {
      command: command.trim().slice(0, VERIFY_COMMAND_MAX),
      ...(exitCode === undefined ? {} : { expectExitCode: exitCode as number }),
      ...(output === undefined ? {} : { expectOutput: output as string })
    }
  }
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
export function updatePlan(
  chatTabId: string | undefined,
  args: Record<string, unknown>,
  evidence: readonly ExecEvidence[] = []
): ToolResult {
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
    const { title, status, verify } = entry as {
      title?: unknown
      status?: unknown
      verify?: unknown
    }
    if (typeof title !== 'string' || !title.trim()) {
      return { ok: false, error: `items[${i}].title must be a non-empty string.` }
    }
    if (!isStatus(status)) {
      return {
        ok: false,
        error: `items[${i}].status must be one of ${STATUSES.join(', ')}.`
      }
    }
    const parsedVerify = parseVerify(verify, i)
    if (!parsedVerify.ok) return { ok: false, error: parsedVerify.error }
    items.push({
      id: `${i + 1}`,
      title: title.trim().slice(0, TITLE_MAX),
      status,
      ...(parsedVerify.verify ? { verify: parsedVerify.verify } : {})
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
  const body = `Plan updated (${done}/${items.length} completed).\n${items
    .map((i, idx) => `${idx + 1}. ${statusMark(i.status)} ${i.title}`)
    .join('\n')}`

  // Contradict a completed step whose check DID run and failed. A check that
  // simply has not run yet is not reported here: the model routinely emits the
  // check and this update in the same response, so the evidence for a sibling
  // call is legitimately absent at this point. That case is caught at the end
  // of the turn instead, where every result is in.
  const contradicted = items
    .filter((i) => i.status === 'completed')
    .map((item) => ({ item, state: verifyPlanStep(item, evidence) }))
    .filter((r) => r.state.kind === 'failed')
  if (contradicted.length === 0) return { ok: true, result: body }

  const reasons = contradicted
    .map(({ item, state }) => `- "${item.title}": ${state.kind === 'failed' ? state.reason : ''}`)
    .join('\n')
  return {
    ok: true,
    result: `${body}\n\nWARNING — a step is marked completed but its own check contradicts that:\n${reasons}\nDo not report success. Fix the underlying problem and re-run the check, or correct the plan.`
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

  // Re-state each step's declared check alongside it. The assertion is the part
  // most worth repeating: it is what the harness will hold the model to, and a
  // step whose check has scrolled out of view is a step it will forget to run.
  const lines = plan.map((item, idx) => {
    const head = `${idx + 1}. ${statusMark(item.status)} ${item.title}`
    if (!item.verify) return head
    const expectations = [
      item.verify.expectExitCode !== undefined && `exit ${item.verify.expectExitCode}`,
      item.verify.expectOutput && `output matching /${item.verify.expectOutput}/`
    ].filter(Boolean)
    return `${head}\n   verify: \`${item.verify.command}\`${
      expectations.length ? ` → expect ${expectations.join(', ')}` : ''
    }`
  })
  const remaining = plan.filter((i) => i.status === 'pending' || i.status === 'in_progress').length
  const hasChecks = plan.some((i) => i.verify)
  const tail =
    remaining === 0
      ? 'Every step is resolved. Report the outcome and stop unless the user asks for more.'
      : 'Keep working through the remaining steps. Call update_plan again as each one completes; do NOT wait for the user to tell you to continue.'
  const checks = hasChecks
    ? '\nThe app checks each verify line against the commands you actually ran, and will not let the turn end while one is unproven.'
    : ''

  return `Current task plan (maintained by you via update_plan):
${lines.join('\n')}

${tail}${checks}`
}
