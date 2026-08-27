/**
 * Delegated per-host sub-agent (`delegate_to_host`).
 *
 * A multi-host task is where a single context window loses: "compare who
 * listens on 8080 on these three hosts" is three `ss` dumps, each a few hundred
 * lines, and the answer is three lines. Pull them all into the main loop and
 * the window is spent on output the user will never read; the compactor then
 * throws away the earlier steps that were the actual work.
 *
 * So each host gets its own bounded loop with its own conversation, and only
 * its report crosses back. Three deliberate limits keep that trade honest:
 *
 * - READ-ONLY. Approval is a conversation with the user, and there is no user
 *   in here — so instead of inventing a second approval channel, the sub-agent
 *   is only allowed what needs no approval. It reuses Plan mode's policy for
 *   exactly this reason: that decision table already means "inspect, never
 *   change", and it is tested.
 * - ONE host. Every host tool call has its `tab_id` overwritten with the
 *   delegated tab, so a sub-agent cannot wander onto another machine even if
 *   the model names one.
 * - A step budget, with a forced tools-off summary turn at the end. A loop with
 *   nobody watching must terminate on its own.
 */
import { buildSubAgentSystemPrompt, buildContextMessage, describeTabOs } from '../../shared/prompts'
import { SUB_AGENT_TOOLS } from '../../shared/aiTools'
import { decideToolCall } from '../../shared/toolPolicy'
import type { ChatMessageDTO } from '../../shared/types'
import { useSessionsStore } from '../store/sessionsStore'
import { COPILOT_CONTEXT_MAX_LINES, readTerminalOutput } from './terminalRegistry'
import { getTabObservation } from './terminalObservation'
import { formatTerminalLabel } from './pinnedTerminal'
import { debugLog } from './debugLog'
import { digestToolResult } from './toolTrace'

/** Tool-calling turns a sub-agent may spend before it must report. */
export const MAX_SUB_AGENT_STEPS = 6

/**
 * Cap per tool result inside the sub-agent. Its own window is the same size as
 * the parent's, and a single `journalctl` can fill it — the point of delegating
 * was to bound exactly this.
 */
const SUB_AGENT_RESULT_CHARS = 6000

/** Result shape the sub-agent needs from an executor, mirroring `ToolResult`. */
export interface SubAgentToolResult {
  ok: boolean
  result?: string
  error?: string
}

/**
 * How the sub-agent runs a tool. Injected rather than imported so this module
 * does not depend on the dispatcher that dispatches TO it.
 */
export type SubAgentExecutor = (
  name: string,
  args: Record<string, unknown>,
  onAbortHandle: (abort: () => void) => void
) => Promise<SubAgentToolResult>

export interface SubAgentParams {
  /** Terminal tab to investigate; every host call is pinned to it. */
  terminalTabId: string
  /** The delegated assignment, self-contained (the sub-agent sees no history). */
  task: string
  execute: SubAgentExecutor
  /** Receives a canceller so the parent's Stop also stops the sub-agent. */
  onAbortHandle?: (abort: () => void) => void
  /** Chat tab that delegated, for debug-log correlation only. */
  chatTabId?: string
}

export interface SubAgentOutcome {
  ok: boolean
  /** The report, when one was produced. */
  report?: string
  error?: string
  /** Tool-calling turns actually spent. */
  steps: number
  /** Shell commands the sub-agent ran, for the parent's evidence line. */
  commands: string[]
  /** True when the step budget forced the summary rather than the model choosing to stop. */
  budgetExhausted?: boolean
}

const SUMMARY_NUDGE =
  'Step budget reached: no more tool calls will be executed. Reply now with your report — the answer, the evidence you actually gathered (command, exit code, the few lines that matter), and what stayed unknown.'

function tabLabel(terminalTabId: string): string {
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === terminalTabId)
  return tab ? formatTerminalLabel(tab) : terminalTabId
}

/**
 * The host context for the sub-agent's own first turn. It is a fresh
 * conversation, so it needs the same orientation the main loop gets: which
 * machine, which shell, what was on screen last.
 */
function hostContextMessage(terminalTabId: string): string | null {
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === terminalTabId)
  if (!tab) return null
  return buildContextMessage({
    recentOutput: readTerminalOutput(tab.id, COPILOT_CONTEXT_MAX_LINES),
    host: tab.host,
    username: tab.username,
    osHint: describeTabOs(tab.kind, tab.wslDistro),
    cwd: getTabObservation(tab.id)?.cwd
  })
}

/**
 * Whether the sub-agent may run this call unattended. Plan mode's table is the
 * right one: auto for reads and for read-only shell commands, deny for
 * everything that changes state — which is precisely the contract advertised in
 * the tool description and the sub-agent prompt.
 */
function allowedForSubAgent(name: string, argsJson: string): boolean {
  if (!(SUB_AGENT_TOOLS as readonly string[]).includes(name)) return false
  return decideToolCall({ tool: name, argsJson, mode: 'balanced', agentMode: 'plan' }) === 'auto'
}

function refusalFor(name: string): string {
  if (name === 'exec_command') {
    return 'Refused: this sub-agent is READ-ONLY, and that command changes state (or its safety could not be established). Investigate with a read-only command instead, and report the change you believe is needed rather than making it.'
  }
  return `Refused: "${name}" is not available to a delegated sub-agent. You may only use: ${SUB_AGENT_TOOLS.join(', ')}.`
}

/** Run the delegated investigation and return its report. */
export async function runSubAgent(params: SubAgentParams): Promise<SubAgentOutcome> {
  const { terminalTabId, task, execute } = params
  const label = tabLabel(terminalTabId)
  const commands: string[] = []
  let aborted = false
  let currentTurnId: string | null = null
  const childAborts = new Set<() => void>()

  params.onAbortHandle?.(() => {
    aborted = true
    if (currentTurnId) window.api.ai.cancel(currentTurnId)
    for (const abort of childAborts) {
      try {
        abort()
      } catch {
        // A canceller for an already-finished command is not worth reporting.
      }
    }
  })

  const systemPrompt = buildSubAgentSystemPrompt({
    hostLabel: label,
    toolNames: SUB_AGENT_TOOLS,
    maxSteps: MAX_SUB_AGENT_STEPS
  })
  const conversation: ChatMessageDTO[] = []
  const context = hostContextMessage(terminalTabId)
  if (context) conversation.push({ role: 'system', content: context })
  conversation.push({ role: 'user', content: task })

  for (let step = 0; step <= MAX_SUB_AGENT_STEPS; step++) {
    if (aborted) {
      return { ok: false, error: 'Cancelled by the user.', steps: step, commands }
    }
    // The extra iteration is the summary turn: tools off, so the only thing the
    // model can do is write the report.
    const budgetExhausted = step === MAX_SUB_AGENT_STEPS
    if (budgetExhausted) conversation.push({ role: 'user', content: SUMMARY_NUDGE })

    const requestId = crypto.randomUUID()
    currentTurnId = requestId
    const turn = await window.api.ai.agentTurn({
      requestId,
      systemPrompt,
      messages: conversation,
      toolNames: budgetExhausted ? [] : [...SUB_AGENT_TOOLS]
    })
    currentTurnId = null
    if (aborted) {
      return { ok: false, error: 'Cancelled by the user.', steps: step, commands }
    }
    if (turn.error) {
      return { ok: false, error: turn.error, steps: step, commands }
    }

    const content = (turn.content ?? '').trim()
    const calls = turn.toolCalls ?? []
    if (calls.length === 0) {
      if (content) {
        return { ok: true, report: content, steps: step, commands, budgetExhausted }
      }
      // Neither a report nor a call. One nudge is already scheduled by the
      // budget turn; before that, push it toward acting.
      conversation.push({
        role: 'user',
        content:
          'You returned neither a tool call nor a report. Run the read-only command that answers the question now, or write the report if you already have the answer.'
      })
      continue
    }

    conversation.push({ role: 'assistant', content, tool_calls: calls })
    for (const call of calls) {
      let args: Record<string, unknown> = {}
      let parseError: string | undefined
      try {
        const parsed = JSON.parse(call.arguments || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          parseError = `Tool arguments must be a JSON object, received: ${call.arguments}`
        } else {
          args = parsed as Record<string, unknown>
        }
      } catch (e) {
        parseError = `Invalid JSON arguments (${e instanceof Error ? e.message : String(e)}): ${call.arguments}`
      }

      let resultText: string
      if (parseError) {
        resultText = `Error: ${parseError}. Re-emit the call with valid JSON.`
      } else if (!allowedForSubAgent(call.name, call.arguments)) {
        resultText = refusalFor(call.name)
      } else {
        // The delegated tab is not negotiable: whatever the model passed, the
        // call lands on the host this delegation is about.
        const scoped: Record<string, unknown> = { ...args, tab_id: terminalTabId }
        if (typeof scoped.command === 'string') commands.push(scoped.command)
        // Per-host serialization is applied by the shared tool dispatcher, so a
        // sub-agent's call is ordered against other chats' writes without this
        // loop needing to know the rule (and without locking against itself).
        const res = await execute(call.name, scoped, (abort) => {
          childAborts.add(abort)
        })
        resultText = res.ok ? (res.result ?? 'Done.') : `Error: ${res.error ?? 'unknown error'}`
      }

      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content:
          resultText.length > SUB_AGENT_RESULT_CHARS
            ? `${digestToolResult(resultText, SUB_AGENT_RESULT_CHARS)}\n[truncated — narrow the command with grep/head]`
            : resultText
      })
    }
    debugLog({
      category: 'action.triggered',
      tabId: params.chatTabId ?? terminalTabId,
      message: 'agent.subAgent.step',
      data: { step: step + 1, host: label, calls: calls.map((c) => c.name) }
    })
  }

  return {
    ok: false,
    error: 'The sub-agent produced no report within its step budget.',
    steps: MAX_SUB_AGENT_STEPS,
    commands,
    budgetExhausted: true
  }
}

/**
 * Render the outcome as the tool result the PARENT sees. It names the host and
 * counts the work so the parent can weigh the report, and keeps the report body
 * verbatim — reformatting a summary is how a second summary's worth of detail
 * gets lost.
 */
export function formatSubAgentResult(label: string, outcome: SubAgentOutcome): string {
  const scope = `Sub-agent report from ${label} (isolated read-only context; ${outcome.steps} step(s), ${outcome.commands.length} command(s) — their raw output stayed in the sub-agent).`
  if (!outcome.ok || !outcome.report) {
    return `${scope}\nNo report: ${outcome.error ?? 'unknown failure'}.${
      outcome.commands.length > 0 ? `\nCommands attempted: ${outcome.commands.join(' ; ')}` : ''
    }`
  }
  const truncatedNote = outcome.budgetExhausted
    ? '\nnote: the sub-agent hit its step budget, so this report may be incomplete.'
    : ''
  return `${scope}${truncatedNote}\n\n${outcome.report}`
}
