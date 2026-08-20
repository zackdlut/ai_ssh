/**
 * Cross-turn Task Memory for the SSH agent.
 *
 * A compact ledger of what the agent has actually done in this chat, injected
 * as a system message each turn so the model can see completed work at a glance
 * instead of re-deriving it from the raw tool chain.
 *
 * This is derived from the chat's persisted messages rather than kept in a
 * side map. The map version was lost on every app restart — the user reopened
 * the app, asked "did that deploy finish?", and the agent had no idea it had
 * ever run anything. Deriving from messages also removes a whole class of
 * drift: the ledger cannot disagree with the conversation it summarizes.
 */
import { useAIStore } from '../store/aiStore'
import type { CopilotChatMessage, ToolCallView } from '../../shared/types'
import { isReadonlyTool } from '../../shared/aiTools'

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
}

/** Keep only the most recent steps so the ledger never bloats the context. */
const MAX_MEMORY_STEPS = 40
/** Clamp each step's summary to keep the ledger compact. */
const SUMMARY_MAX = 200

/** Parse the structured result string produced by the exec_command tool. */
function parseExecResult(result: string): {
  exitCode: number | null
  cwd?: string
  outputTail: string
} {
  const ecMatch = /^exit_code:\s*(.+)$/m.exec(result)
  const cwdMatch = /^cwd:\s*(.+)$/m.exec(result)
  const outIdx = result.indexOf('output:\n')
  const output = outIdx >= 0 ? result.slice(outIdx + 'output:\n'.length) : result
  let exitCode: number | null = null
  if (ecMatch) {
    const n = Number.parseInt(ecMatch[1].trim(), 10)
    exitCode = Number.isFinite(n) ? n : null
  }
  return {
    exitCode,
    cwd: cwdMatch ? cwdMatch[1].trim() : undefined,
    outputTail: output.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
  }
}

function clamp(text: string | undefined): string | undefined {
  if (!text) return undefined
  return text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX) || undefined
}

function stepFromCall(call: ToolCallView, index: number): TaskStep | null {
  // Read-only lookups leave no lasting state, so they would only dilute the
  // ledger with noise the model can re-derive at any time.
  if (isReadonlyTool(call.name)) return null
  if (call.status === 'pending' || call.status === 'running') return null

  const status: TaskStep['status'] =
    call.status === 'rejected' ? 'rejected' : call.status === 'error' ? 'error' : 'ok'
  const content = call.error ? `Error: ${call.error}` : (call.result ?? '')

  if (call.name === 'exec_command' || call.name === 'run_in_terminal') {
    let label = '(command)'
    try {
      const args = JSON.parse(call.args) as { command?: unknown }
      if (typeof args.command === 'string') label = args.command
    } catch {
      /* keep placeholder */
    }
    if (status === 'ok') {
      const parsed = parseExecResult(content)
      return {
        index,
        kind: 'exec',
        label,
        cwd: parsed.cwd,
        exitCode: parsed.exitCode,
        status,
        summary: parsed.outputTail || undefined
      }
    }
    return { index, kind: 'exec', label, status, summary: clamp(content) }
  }

  return {
    index,
    kind: 'action',
    label: call.name,
    status,
    summary: status === 'ok' ? clamp(callHighlight(call)) : clamp(content)
  }
}

/**
 * One-line highlight for a non-exec action. File writes carry the path, which
 * is exactly what a later turn needs ("you already edited /etc/nginx.conf").
 */
function callHighlight(call: ToolCallView): string | undefined {
  if (call.name === 'edit_file' || call.name === 'write_file') {
    try {
      const args = JSON.parse(call.args) as { path?: unknown }
      if (typeof args.path === 'string') return args.path
    } catch {
      /* fall through */
    }
  }
  return undefined
}

/** Derive the ledger from a chat's messages (pure; safe to unit test). */
export function deriveTaskSteps(messages: CopilotChatMessage[]): TaskStep[] {
  const steps: TaskStep[] = []
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const step = stepFromCall(call, steps.length + 1)
      if (step) steps.push(step)
    }
  }
  return steps.slice(-MAX_MEMORY_STEPS)
}

export function formatTaskSteps(steps: TaskStep[]): string | undefined {
  if (steps.length === 0) return undefined
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

/**
 * Build the compact ledger injected each turn. Returns undefined when nothing
 * has been executed yet so no empty section is added.
 */
export function buildTaskMemoryMessage(chatTabId: string): string | undefined {
  const messages = useAIStore.getState().chatTabs.find((t) => t.id === chatTabId)?.messages
  if (!messages) return undefined
  return formatTaskSteps(deriveTaskSteps(messages))
}
