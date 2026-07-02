/**
 * Cross-turn Task Memory for the SSH agent.
 *
 * The agent loop's `conversation` (with its tool-call chain) only lives for a
 * SINGLE user input: the next `sendPrompt` rebuilds history from persisted
 * messages as role+content only, dropping every prior tool execution. That made
 * the agent forget what it just did as soon as the user sent a follow-up ("now
 * restart that service"). This module keeps a compact, per-chat ledger of the
 * actions performed across the whole session and injects it as a system message
 * each turn, so the model retains an accurate memory of completed steps without
 * replaying raw (and expensive) tool output.
 */
export interface TaskStep {
  index: number
  kind: 'exec' | 'action'
  /** The command (exec) or the tool name (action). */
  label: string
  cwd?: string
  /** Shell exit code for exec steps; undefined/null when unknown. */
  exitCode?: number | null
  status: 'ok' | 'error' | 'rejected'
  /** Short summary of the result/output (already clamped). */
  summary?: string
  at: number
}

/** Keep only the most recent steps so the ledger never bloats the context. */
const MAX_MEMORY_STEPS = 40
/** Clamp each step's summary to keep the ledger compact. */
const SUMMARY_MAX = 200

const memories = new Map<string, TaskStep[]>()

export function recordTaskStep(chatTabId: string, step: Omit<TaskStep, 'index'>): void {
  const steps = memories.get(chatTabId) ?? []
  const summary = step.summary
    ? step.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
    : undefined
  steps.push({ ...step, summary, index: steps.length + 1 })
  memories.set(chatTabId, steps.slice(-MAX_MEMORY_STEPS))
}

export function clearTaskMemory(chatTabId: string): void {
  memories.delete(chatTabId)
}

/**
 * Build the compact ledger injected each turn. Returns undefined when nothing
 * has been executed yet so no empty section is added.
 */
export function buildTaskMemoryMessage(chatTabId: string): string | undefined {
  const steps = memories.get(chatTabId)
  if (!steps || steps.length === 0) return undefined
  const lines = steps.map((s) => {
    if (s.kind === 'exec') {
      const ec = s.exitCode === null || s.exitCode === undefined ? '?' : String(s.exitCode)
      const where = s.cwd ? ` [${s.cwd}]` : ''
      const out = s.summary ? ` | ${s.summary}` : ''
      return `${s.index}. exec${where} \`${s.label}\` -> exit ${ec}${out}`
    }
    const st = s.status === 'ok' ? 'ok' : s.status
    const out = s.summary ? ` | ${s.summary}` : ''
    return `${s.index}. action ${s.label} -> ${st}${out}`
  })
  return `Task execution history (actions ALREADY performed earlier in this session — use this to avoid repeating completed steps and to remember prior results; re-run a step only if you need fresh state):
${lines.join('\n')}`
}
