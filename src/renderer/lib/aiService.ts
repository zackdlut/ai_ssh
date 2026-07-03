import { useAIStore, DEFAULT_CHAT_TAB_TITLE } from '../store/aiStore'
import { useTabsStore } from '../store/tabsStore'
import { COPILOT_CONTEXT_MAX_LINES, COPILOT_TERMINAL_MENTION_MAX_LINES, readTerminalOutput } from './terminalRegistry'
import { getTabObservation } from './terminalObservation'
import { normalizeAISettings, resolveActiveContextLength } from '../../shared/aiSettings'
import { buildEffectiveSystemPrompt } from '../../shared/userRules'
import { selectMessagesToCompress, buildChatPayload, type BudgetMessage } from '../../shared/contextBudget'
import { buildContextMessage } from '../../shared/terminalContext'
import { translate } from './i18n/translations'
import { useLocaleStore } from '../store/localeStore'
import { debugLog } from './debugLog'
import { AI_TOOLS, isDisplayTool, isReadonlyTool, requiresToolApproval } from '../../shared/aiTools'
import {
  buildSkillsContextMessage,
  buildToolContextMessage,
  executeToolCall,
  parseToolArgs
} from './aiTools'
import {
  getPendingToolCalls,
  hasDangerousPending,
  hasPendingToolCalls,
  parseToolApprovalInput
} from './toolApproval'
import {
  accountTokens,
  checkLoopGuard,
  createGuardState,
  MAX_STEPS,
  noProgressStreak,
  recordTurn,
  turnSignature,
  type GuardState,
  type GuardTrip
} from './loopGuard'
import { buildTaskMemoryMessage, recordTaskStep } from './taskMemory'
import { transition, type AgentEvent, type AgentPhase } from './agentPhase'
import type { ChatMessage } from '../store/aiStore'
import { useUserRulesStore } from '../store/userRulesStore'
import type { ChatMessageDTO, TerminalContext, ToolCallView } from '../../shared/types'

/**
 * State for an in-progress function-calling agent loop. The `conversation`
 * carries the running model message list (user turn, assistant tool-call turns,
 * and tool-result turns) that is replayed on each continuation. The loop pauses
 * whenever an action tool needs user approval and resumes once every tool call
 * in the latest assistant turn has reached a terminal state.
 */
interface LoopState {
  tabId: string
  context?: TerminalContext
  boundSessionId?: string
  boundTabId?: string
  conversation: ChatMessageDTO[]
  /** True once we've auto-nudged a degenerate (empty, no-tool-call) turn. */
  nudged?: boolean
  /**
   * True once a mutating (non read-only) tool has been executed within this
   * loop. Read-only lookups (the list_ and get_ tools) do NOT count: an empty
   * turn that follows only read-only tools usually means the model planned in
   * its reasoning but forgot to emit the action, so it should still be nudged.
   */
  executedActionTool?: boolean
  /** Loop Guard counters (steps, token spend, no-progress detection). */
  guard?: GuardState
  /** Current phase in the explicit agent state machine (observability). */
  phase?: AgentPhase
  /** True once a just-in-time reflection nudge has been injected this task. */
  reflected?: boolean
  /**
   * The user asked to VISUALIZE terminal output as a chart (@terminal + a
   * charting verb). For the first turn we disable function-calling and inject a
   * hard "emit a chart block" nudge: small local models otherwise almost always
   * run the collection command as a tool/bash instead of emitting the ```chart
   * fence, so the two-phase chart pipeline never starts. See sendPrompt.
   */
  chartIntent?: boolean
  /**
   * The raw user instruction that kicked off this loop. Used by the Verify step
   * to decide, after a display-only tool turn, whether the request was pure
   * "show me X" (stop once the card is shown) or a "show then act" intent that
   * should keep looping. Set once in sendPrompt and never rewritten by injected
   * nudge/reflection turns, so it always reflects the real intent.
   */
  userIntent?: string
}

interface PendingRequest {
  tabId: string
  messageId: string
  loop: LoopState
  /**
   * An "epilogue" turn: the follow-up LLM turn that runs right after a turn
   * which executed ONLY display tools (the list_ tools / get_app_settings). The
   * rich card already answers the user, so this turn is rendered invisibly: it
   * is materialized only if the model decides to ACT (emits another tool call);
   * a text-only epilogue (a redundant restatement of the card) is dropped.
   */
  epilogue?: boolean
}

/** Maps an in-flight requestId to the assistant message being streamed. */
const pending = new Map<string, PendingRequest>()
/** Assistant messages whose tool calls are awaiting execution/approval. */
const loops = new Map<string, LoopState>()
let initialized = false

function findMessage(tabId: string, messageId: string): ChatMessage | undefined {
  const tab = useAIStore.getState().chatTabs.find((t) => t.id === tabId)
  return tab?.messages.find((m) => m.id === messageId)
}

/**
 * Apply a state-machine transition to the loop and log the phase change. This is
 * the single place the loop's phase moves, so every branch of the event-driven
 * flow maps to a named, observable transition.
 */
function advance(loop: LoopState, event: AgentEvent, tabId: string): AgentPhase {
  const from = loop.phase ?? 'idle'
  const to = transition(from, event)
  loop.phase = to
  if (to !== from) {
    debugLog({
      category: 'action.triggered',
      tabId,
      message: 'agent.phase',
      data: { from, event, to }
    })
  }
  return to
}

/**
 * Begin one LLM turn for the loop: a fresh assistant message + chat request.
 *
 * When `epilogue` is true the turn follows a display-only tool turn (its card is
 * already the answer). We DON'T create a visible assistant message up front and
 * we drop its streamed chunks: the turn is only materialized in `onDone` if it
 * actually emits a tool call. This prevents the model from restating the card as
 * prose, without any visible "text flashes in then disappears" flicker.
 */
function startTurn(loop: LoopState, epilogue = false): void {
  const ai = useAIStore.getState()
  // A chart-visualization request only applies to the FIRST turn: emit the
  // ```chart fence with tools OFF (below), then the loop is done — there is no
  // continuation to keep nudging.
  const firstTurn = loop.phase === undefined
  const chartTurn = !!loop.chartIntent && firstTurn
  // Only assemble the prompt sections this turn actually needs: the long chart
  // rules ride along only on the (first) chart turn, mermaid rules only when the
  // request asked for a diagram, and continuation turns drop first-turn examples.
  const promptSections = {
    chart: chartTurn,
    mermaid: MERMAID_INTENT.test(loop.userIntent ?? ''),
    concise: !firstTurn
  }
  const snapshot = buildToolContextMessage()
  const skillsCatalog = buildSkillsContextMessage()
  const taskMemory = buildTaskMemoryMessage(loop.tabId)
  const prefix: ChatMessageDTO[] = []
  if (skillsCatalog) prefix.push({ role: 'system', content: skillsCatalog })
  if (snapshot) prefix.push({ role: 'system', content: snapshot })
  // Cross-turn ledger of actions already performed this session, so follow-up
  // user turns retain memory of prior tool executions (the conversation itself
  // is rebuilt as role+content only across user turns).
  if (taskMemory) prefix.push({ role: 'system', content: taskMemory })
  const messages: ChatMessageDTO[] = [...prefix, ...loop.conversation]
  // Append the chart nudge as the LAST (trailing user) message: recency beats
  // the large tool-oriented system prompt, which otherwise wins and the model
  // answers with a bare bash block. It is NOT written back to loop.conversation,
  // so it never leaks into persisted history or later turns.
  if (chartTurn) messages.push({ role: 'user', content: CHART_TURN_NUDGE })

  // Entering an LLM turn is the "thinking" phase of the state machine.
  advance(loop, loop.phase ? 'continue' : 'prompt', loop.tabId)

  // Loop Guard bookkeeping: every turn counts as a step and adds its outgoing
  // token cost to the task-level budget. The limits are enforced in
  // maybeContinueLoop before a continuation is started.
  loop.guard ??= createGuardState()
  loop.guard.stepCount += 1
  accountTokens(loop.guard, messages.map((m) => m.content))

  const assistantId = crypto.randomUUID()
  const requestId = crypto.randomUUID()
  if (!epilogue) {
    ai.addMessage(loop.tabId, {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
      boundSessionId: loop.boundSessionId,
      boundTabId: loop.boundTabId
    })
  }
  pending.set(requestId, { tabId: loop.tabId, messageId: assistantId, loop, epilogue })
  ai.setBusy(true, requestId, loop.tabId)
  const userRules = useUserRulesStore.getState().rules
  debugLog({
    category: 'action.triggered',
    traceId: requestId,
    tabId: loop.tabId,
    message: epilogue ? 'agent.startTurn.epilogue' : 'agent.startTurn',
    data: { messageCount: messages.length, epilogue }
  })
  window.api.ai.chat({
    requestId,
    messages,
    context: loop.context,
    enableTools: !chartTurn,
    userRules,
    promptSections
  })
}

/** Execute a single tool call and record its outcome, then advance the loop. */
async function runToolCall(tabId: string, messageId: string, callId: string): Promise<void> {
  const ai = useAIStore.getState()
  const call = findMessage(tabId, messageId)?.toolCalls?.find((c) => c.id === callId)
  if (!call) return
  if (!isReadonlyTool(call.name)) {
    const loop = loops.get(messageId)
    if (loop) loop.executedActionTool = true
  }
  ai.updateToolCall(tabId, messageId, callId, { status: 'running' })
  debugLog({
    category: 'action.triggered',
    tabId,
    message: `tool.${call.name}`,
    data: { args: parseToolArgs(call.args) }
  })
  try {
    const res = await executeToolCall(call.name, parseToolArgs(call.args), {
      onCaptureProgress:
        call.name === 'exec_command'
          ? (elapsedMs) => {
              ai.updateToolCall(tabId, messageId, callId, { progressMs: elapsedMs })
            }
          : undefined
    })
    debugLog({
      category: 'action.triggered',
      tabId,
      message: `tool.${call.name}.result`,
      data: { ok: res.ok, result: res.ok ? res.result : res.error }
    })
    if (res.ok) {
      ai.updateToolCall(tabId, messageId, callId, { status: 'done', result: res.result })
    } else {
      ai.updateToolCall(tabId, messageId, callId, { status: 'error', error: res.error })
    }
  } catch (e) {
    ai.updateToolCall(tabId, messageId, callId, {
      status: 'error',
      error: e instanceof Error ? e.message : String(e)
    })
  }
  maybeContinueLoop(tabId, messageId)
}

/** Approve a pending (action) tool call from the UI. */
export function approveToolCall(tabId: string, messageId: string, callId: string): void {
  const loop = loops.get(messageId)
  if (loop) advance(loop, 'approved', tabId)
  void runToolCall(tabId, messageId, callId)
}

/** Reject a pending (action) tool call from the UI. */
export function rejectToolCall(tabId: string, messageId: string, callId: string): void {
  const loop = loops.get(messageId)
  if (loop) advance(loop, 'rejected', tabId)
  const call = findMessage(tabId, messageId)?.toolCalls?.find((c) => c.id === callId)
  debugLog({
    category: 'action.triggered',
    tabId,
    message: call ? `tool.${call.name}.rejected` : 'tool.rejected',
    data: { callId }
  })
  useAIStore.getState().updateToolCall(tabId, messageId, callId, {
    status: 'rejected',
    result: 'User rejected this action.'
  })
  maybeContinueLoop(tabId, messageId)
}

export type ToolApprovalHandleResult =
  | { handled: false }
  | { handled: true; action: 'approve' | 'reject'; count: number }
  | { handled: true; action: 'dangerous_blocked' }

/**
 * When action tools are awaiting approval, interpret short chat replies like
 * "确认" / "approve" as approve/reject. Anything that is NOT an approve/reject
 * phrase is treated as a NEW instruction (handled:false) and flows through to
 * sendPrompt, which supersedes the pending actions. Destructive actions are
 * never approved via a loose chat phrase — they must use the card buttons.
 */
export function tryHandleToolApprovalFromInput(
  tabId: string,
  text: string
): ToolApprovalHandleResult {
  if (!hasPendingToolCalls(tabId)) return { handled: false }

  const action = parseToolApprovalInput(text)
  if (action === 'approve') {
    // Refuse to approve destructive actions from a fuzzy chat phrase; the user
    // must click Approve on the card so the intent is unambiguous.
    if (hasDangerousPending(tabId)) {
      debugLog({
        category: 'user.action',
        tabId,
        message: 'tool.approval.dangerBlocked',
        data: { text }
      })
      return { handled: true, action: 'dangerous_blocked' }
    }
    const refs = getPendingToolCalls(tabId)
    debugLog({
      category: 'user.action',
      tabId,
      message: 'tool.approval.approve',
      data: { count: refs.length, text }
    })
    for (const ref of refs) approveToolCall(tabId, ref.messageId, ref.callId)
    return refs.length > 0 ? { handled: true, action: 'approve', count: refs.length } : { handled: false }
  }
  if (action === 'reject') {
    const refs = getPendingToolCalls(tabId)
    debugLog({
      category: 'user.action',
      tabId,
      message: 'tool.approval.reject',
      data: { count: refs.length, text }
    })
    for (const ref of refs) rejectToolCall(tabId, ref.messageId, ref.callId)
    return refs.length > 0 ? { handled: true, action: 'reject', count: refs.length } : { handled: false }
  }
  // Not an approve/reject phrase: let it flow through as a new instruction.
  return { handled: false }
}

/**
 * Abandon every pending (awaiting-approval) tool call in a tab without
 * continuing its agent loop: the loops are dropped and the calls marked
 * rejected. Used when a new user instruction supersedes proposed actions so the
 * app does not stay stuck waiting on approvals the user has effectively dropped.
 */
export function cancelPendingApprovals(tabId: string): void {
  const refs = getPendingToolCalls(tabId)
  if (refs.length === 0) return
  const ai = useAIStore.getState()
  for (const ref of refs) {
    loops.delete(ref.messageId)
    ai.updateToolCall(tabId, ref.messageId, ref.callId, {
      status: 'rejected',
      result: 'Superseded by a new instruction.'
    })
  }
  debugLog({
    category: 'user.action',
    tabId,
    message: 'tool.approval.superseded',
    data: { count: refs.length }
  })
  // The paused turn's request already completed; clear busy so the new prompt
  // can start a fresh turn.
  ai.setBusy(false)
}

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
    outputTail: output.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
}

/**
 * Record a completed tool call into the cross-turn Task Memory ledger. Read-only
 * lookups are skipped (they carry no lasting state); exec_command steps store
 * the command + exit code + a short output tail; other action tools store a
 * brief outcome line.
 */
function recordCallInTaskMemory(chatTabId: string, call: ToolCallView, content: string): void {
  if (isReadonlyTool(call.name)) return
  const status: 'ok' | 'error' | 'rejected' =
    call.status === 'rejected' ? 'rejected' : call.status === 'error' ? 'error' : 'ok'

  if (call.name === 'exec_command') {
    let command = '(command)'
    try {
      const args = JSON.parse(call.args) as { command?: unknown }
      if (typeof args.command === 'string') command = args.command
    } catch {
      /* keep placeholder */
    }
    if (status === 'ok') {
      const parsed = parseExecResult(content)
      recordTaskStep(chatTabId, {
        kind: 'exec',
        label: command,
        cwd: parsed.cwd,
        exitCode: parsed.exitCode,
        status,
        summary: parsed.outputTail || undefined,
        at: Date.now()
      })
    } else {
      recordTaskStep(chatTabId, {
        kind: 'exec',
        label: command,
        status,
        summary: content,
        at: Date.now()
      })
    }
    return
  }

  recordTaskStep(chatTabId, {
    kind: 'action',
    label: call.name,
    status,
    summary: status === 'ok' ? undefined : content,
    at: Date.now()
  })
}

/**
 * Stop a runaway loop and tell the user why. Called when the Loop Guard trips
 * (too many steps, no progress, or the token budget is exhausted) so the loop
 * ends with a clear, actionable notice instead of continuing to burn turns.
 */
function stopLoopWithGuardNotice(tabId: string, loop: LoopState, trip: GuardTrip): void {
  if (!trip.tripped) return
  const ai = useAIStore.getState()
  const message =
    trip.reason === 'max_steps'
      ? tNotice('copilot.loopGuard.maxSteps', { max: MAX_STEPS })
      : trip.reason === 'token_budget'
        ? tNotice('copilot.loopGuard.tokenBudget')
        : tNotice('copilot.loopGuard.repeat')
  ai.addMessage(tabId, {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: message,
    boundSessionId: loop.boundSessionId,
    boundTabId: loop.boundTabId
  })
  debugLog({
    category: 'action.triggered',
    tabId,
    message: 'agent.loopGuard.tripped',
    data: { reason: trip.reason, steps: loop.guard?.stepCount, tokens: loop.guard?.tokenSpent }
  })
  ai.setBusy(false)
}

/**
 * Operation intent in the user's instruction: verbs that imply the user wants
 * the copilot to CHANGE state (open/close a tab, create/update a config, move a
 * connection, run/restart/install something, change settings), not merely SEE
 * the current state. Used by the Verify step: when a turn ran ONLY display tools
 * and the request carries one of these verbs, the list was likely a lookup step
 * before an action, so the loop keeps going; otherwise the card is the answer.
 */
const ACTION_INTENT =
  /\b(open|connect|close|create|add|update|edit|change|modify|set|rename|move|delete|remove|run|exec|execute|restart|start|stop|kill|install|deploy|enable|disable)\b|打开|连接|关闭|新建|创建|添加|更新|修改|改成?|设置|重命名|移动|移除|删除|运行|执行|重启|启动|停止|安装|部署|启用|禁用/i

/**
 * The Verify step of the ReAct loop. After a turn's tool results are observed,
 * decide whether the goal is already met (`finalAnswer`, stop) or the loop
 * should keep going (`continue`). Today this only short-circuits the common
 * "just show me X" case: a turn that ran ONLY display tools (the list_ / get_
 * lookups), all succeeded, AND whose originating instruction shows no operation intent is
 * fully answered by the rich card — so we stop instead of burning an extra
 * (invisible) epilogue LLM turn. Every other shape keeps looping unchanged.
 *
 * Heuristic limitation (intentional): a "show + analyze" ask with no operation
 * verb (e.g. "list hosts and tell me which is prod") is treated as pure display
 * and stops; the user can follow up. This trades a rare missed analysis for
 * never spending a silent turn on the overwhelmingly common lookup case.
 */
function evaluateAfterObservation(
  loop: LoopState,
  calls: { name: string; status: string }[]
): 'continue' | 'finalAnswer' {
  const displayOnly = calls.every((c) => isDisplayTool(c.name) && c.status === 'done')
  if (!displayOnly) return 'continue'
  if (loop.userIntent && ACTION_INTENT.test(loop.userIntent)) return 'continue'
  return 'finalAnswer'
}

/** When every tool call of a turn is resolved, feed results back and continue. */
function maybeContinueLoop(tabId: string, messageId: string): void {
  const loop = loops.get(messageId)
  if (!loop) return
  const calls = findMessage(tabId, messageId)?.toolCalls
  if (!calls || calls.length === 0) return
  if (calls.some((c) => c.status === 'pending' || c.status === 'running')) return

  loops.delete(messageId)
  const signatureCalls: { name: string; args: string; result: string }[] = []
  for (const c of calls) {
    const content =
      c.status === 'rejected'
        ? 'User rejected this action.'
        : c.error
          ? `Error: ${c.error}`
          : (c.result ?? 'Done.')
    loop.conversation.push({ role: 'tool', tool_call_id: c.id, content })
    signatureCalls.push({ name: c.name, args: c.args, result: content })
    recordCallInTaskMemory(loop.tabId, c, content)
  }

  // Tool results are now captured: observe -> verify.
  advance(loop, 'toolExecuted', tabId)
  advance(loop, 'observed', tabId)

  // Loop Guard: record this turn's signature and stop before continuing if a
  // hard limit is hit (max steps, no-progress repeats, or token budget).
  loop.guard ??= createGuardState()
  recordTurn(loop.guard, turnSignature(signatureCalls))
  const trip = checkLoopGuard(loop.guard)
  if (trip.tripped) {
    advance(loop, 'guardTripped', tabId)
    stopLoopWithGuardNotice(tabId, loop, trip)
    return
  }

  // Verify: decide whether the goal is met. When a turn ran ONLY display tools
  // (list_*/get_*) that all succeeded and the request had no operation intent,
  // the rich card IS the final answer — stop here instead of spending an extra
  // invisible epilogue turn (which, being tool-call-free, would just be dropped
  // anyway). Every other shape keeps looping.
  if (evaluateAfterObservation(loop, calls) === 'finalAnswer') {
    advance(loop, 'finalAnswer', tabId)
    debugLog({ category: 'action.triggered', tabId, message: 'agent.verify.done', data: {} })
    useAIStore.getState().setBusy(false)
    return
  }

  // Just-in-time Reflection: the loop is repeating the same action with the same
  // result but has not YET hit the hard repeat limit. Inject a one-shot reflect
  // prompt so the model changes strategy instead of grinding into the guard.
  if (!loop.reflected && noProgressStreak(loop.guard) >= 2) {
    loop.reflected = true
    debugLog({ category: 'action.triggered', tabId, message: 'agent.reflect', data: {} })
    loop.conversation.push({
      role: 'user',
      content:
        'Reflection checkpoint: your last actions repeated with the SAME result and made no progress. Do NOT repeat the same command again. Step back and reconsider: what assumption is wrong, what different approach or diagnostic could work, or is user input needed? Either change strategy now or state clearly why you are blocked and ask the user.'
    })
  }

  // Continue the loop. If this turn ran ONLY display tools that all succeeded
  // (reached here only when the request DID carry operation intent — a "show
  // then act" flow), run the follow-up as an invisible "epilogue" turn: a
  // text-only restatement of the cards is dropped, but a real follow-up action
  // is materialized and executed.
  const displayOnly = calls.every((c) => isDisplayTool(c.name) && c.status === 'done')
  startTurn(loop, displayOnly)
}

/**
 * Register the streaming IPC listeners exactly once for the app lifetime, so
 * chat responses are received regardless of whether the side panel is mounted.
 */
export function initAIService(): void {
  if (initialized) return
  initialized = true

  window.api.ai.onChunk(({ requestId, delta }) => {
    const entry = pending.get(requestId)
    // Epilogue turns have no visible message yet; their text is dropped unless
    // the turn turns out to emit a tool call (handled in onDone).
    if (entry && !entry.epilogue) {
      useAIStore.getState().appendToMessage(entry.tabId, entry.messageId, delta)
    }
  })
  window.api.ai.onReasoning(({ requestId, delta }) => {
    const entry = pending.get(requestId)
    if (entry && !entry.epilogue) {
      useAIStore.getState().appendReasoning(entry.tabId, entry.messageId, delta)
    }
  })
  window.api.ai.onDone(({ requestId, content, toolCalls }) => {
    const entry = pending.get(requestId)
    pending.delete(requestId)
    if (!entry) {
      useAIStore.getState().setBusy(false)
      return
    }
    const { tabId, messageId, loop, epilogue } = entry
    const ai = useAIStore.getState()

    if (!toolCalls || toolCalls.length === 0) {
      // An epilogue turn with no tool call is just a redundant restatement of
      // the card(s) already shown — drop it entirely (nothing was rendered).
      if (epilogue) {
        ai.setBusy(false)
        return
      }
      advance(loop, 'finalAnswer', tabId)
      ai.finishMessage(tabId, messageId)
      if (content.trim() === '') {
        // Degenerate turn: the model produced neither a visible answer nor a
        // tool call (common with reasoning models that "plan" only in their
        // thoughts). Nudge it once to actually act or answer. An empty turn
        // AFTER a mutating action already ran is a legitimate "nothing more to
        // say" — but an empty turn after only read-only lookups (list_*/get_*)
        // usually means the model forgot to emit the action it just planned,
        // so we still nudge in that case.
        if (!loop.nudged && !loop.executedActionTool) {
          loop.nudged = true
          debugLog({
            category: 'action.triggered',
            traceId: requestId,
            tabId,
            message: 'agent.nudge',
            data: { reason: 'empty_turn_no_tools' }
          })
          ai.removeMessage(tabId, messageId)
          loop.conversation.push({
            role: 'user',
            content:
              'You produced no visible answer and called no tool. If you intended to perform an action (open/close a tab, create or update a saved config, create a folder, move a connection into a folder, run a command, or change app settings), call the appropriate tool NOW in this response — do not only describe it in your reasoning, and do not wait for me to say "continue". Use the exact ids from the per-turn snapshot. Otherwise, answer the user directly.'
          })
          startTurn(loop)
          return
        }
        if (loop.nudged) {
          // Already nudged once and STILL empty: surface a fallback so the user
          // is not left staring at their prompt with no reply at all.
          ai.appendToMessage(tabId, messageId, tNotice('copilot.emptyReply'))
          ai.finishMessage(tabId, messageId)
        } else {
          // Empty turn right after a mutating action already ran: legitimately
          // "nothing more to say" — drop the blank bubble.
          ai.removeMessage(tabId, messageId)
        }
      }
      ai.setBusy(false)
      return
    }

    // The turn emitted tool calls. An epilogue turn was rendered invisibly, so
    // materialize its assistant message now (the model chose to act, e.g. a
    // multi-step "show then update" flow); a normal turn was streamed live, so
    // just finalize it.
    if (epilogue) {
      ai.addMessage(tabId, {
        id: messageId,
        role: 'assistant',
        content,
        boundSessionId: loop.boundSessionId,
        boundTabId: loop.boundTabId
      })
    } else {
      ai.finishMessage(tabId, messageId)
    }

    // Record the assistant turn (with tool calls) into the running conversation,
    // attach the tool-call views for rendering, and execute them. Read-only
    // tools run immediately; action tools wait for user approval. Busy stays
    // true until the loop produces a final, tool-call-free answer.
    debugLog({
      category: 'action.triggered',
      traceId: requestId,
      tabId,
      message: 'agent.toolCalls',
      data: { toolCalls: toolCalls.map((tc) => ({ name: tc.name, id: tc.id })) }
    })
    advance(loop, 'toolCalls', tabId)
    loop.conversation.push({ role: 'assistant', content, tool_calls: toolCalls })
    const views: ToolCallView[] = toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.arguments,
      status: requiresToolApproval(tc.name, tc.arguments) ? 'pending' : 'running'
    }))
    ai.setToolCalls(tabId, messageId, views)
    loops.set(messageId, loop)

    if (views.some((v) => v.status === 'pending')) advance(loop, 'needApproval', tabId)

    for (const tc of toolCalls) {
      if (!requiresToolApproval(tc.name, tc.arguments)) void runToolCall(tabId, messageId, tc.id)
    }
  })
  window.api.ai.onError(({ requestId, error }) => {
    const entry = pending.get(requestId)
    pending.delete(requestId)
    if (entry) {
      const ai = useAIStore.getState()
      advance(entry.loop, 'recover', entry.tabId)
      if (entry.epilogue) {
        // No visible message exists for an epilogue turn yet — create one so the
        // error is surfaced to the user instead of being silently swallowed.
        ai.addMessage(entry.tabId, {
          id: entry.messageId,
          role: 'assistant',
          content: `[Error] ${error}`
        })
      } else {
        ai.appendToMessage(entry.tabId, entry.messageId, `\n\n[Error] ${error}`)
        ai.finishMessage(entry.tabId, entry.messageId)
      }
      loops.delete(entry.messageId)
    }
    useAIStore.getState().setBusy(false)
  })
}

/** Matches the @terminal mention used to bind the active terminal's live output. */
const TERMINAL_MENTION = /@terminal\b/i

/**
 * Charting intent in the user's prompt (paired with @terminal). Matches the CN
 * chart nouns from the copilot prompt plus common EN verbs. Used to force the
 * chart path: with function-calling enabled, small local models overwhelmingly
 * prefer running the collection command as a tool/bash over emitting the
 * ```chart fence, so the two-phase renderer never starts.
 */
const CHART_INTENT =
  /折线图|柱状图|饼图|散点图|条形图|曲线图?|图表|实时图|可视化|画(个|成|张|一)?图|chart|plot|graph|visuali[sz]e/i

/**
 * Mermaid diagram intent. Used to decide whether to inject the (long) mermaid
 * authoring rules into the system prompt for a turn; unlike charts it needs no
 * @terminal binding and may be produced on any turn (e.g. after investigating).
 */
const MERMAID_INTENT =
  /流程图|时序图|顺序图|架构图|关系图|状态图|类图|甘特图|泳道|拓扑图|mermaid|flowchart|sequence\s*diagram|diagram|\bUML\b/i

/**
 * First-turn-only instruction that forces the chart-block format when the user
 * asked to visualize terminal output. Appended as the trailing user message
 * with tools disabled; empirically this makes even a small local model reliably
 * emit the ```chart fence instead of running the command directly. The explicit
 * template matters — a plain instruction loses to the large tool-oriented
 * system prompt that pushes bare bash blocks.
 */
const CHART_TURN_NUDGE = `[CHART MODE — overrides the general output rules for THIS reply]
The user asked to VISUALIZE terminal output. Do NOT just print a bash command as the answer. Your reply MUST contain a fenced block tagged EXACTLY \`chart\` FIRST, then a separate \`bash\` block.
The \`chart\` block body is ONE short sentence describing: chart type (line/bar/pie/scatter), live or static, the source command, and per series the column header/field index (or inline value) to plot, plus any transform (e.g. CPU usage = 100 - id).

The \`bash\` block MUST be a SINGLE simple command whose plain text output the app parses line by line — the columns it prints MUST match what the chart block references.
FORBIDDEN in the command: \`watch\`, \`while\`/\`for\` loops, \`awk\`/\`sed\`/\`cut\` post-processing, subshells, and full-screen/interactive tools (\`top\` without \`-b\`, \`htop\`). Emit the raw tool so its native columns stream through unmodified.
Use these canonical commands unless the user clearly needs another tool:
- CPU: \`vmstat 1\` (idle = the "id" column; CPU usage = 100 - id).
- Memory: \`free -m -s 1\` (parse the "Mem:" row; "used" is field index 2, "total" is 1, "available" is 6).
- Disk latency / IO: \`iostat -x 1\`.
- Ping latency: \`ping <host>\` (regex time=([0-9.]+)).
- Disk usage breakdown (static pie/bar): \`du -h --max-depth=1 <path> | sort -rh | head -15\`.

Template — fill in and adapt, keep the fences:
\`\`\`chart
<实时/静态><折线/柱状/饼/散点>图：<指标>，数据来自 <命令> 的 <列名/字段>，<变换如 使用率 = 100 - id>，x 轴按时间，保留最近 60 个点。
\`\`\`
\`\`\`bash
<the collection command>
\`\`\`
A reply without a \`chart\` block, or whose \`bash\` command uses watch/loops/awk, is WRONG.`

const TAB_TITLE_MAX = 24

function autoTitleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= TAB_TITLE_MAX) return oneLine
  return oneLine.slice(0, TAB_TITLE_MAX) + '…'
}

function tNotice(key: Parameters<typeof translate>[1], vars?: Record<string, string | number>): string {
  return translate(useLocaleStore.getState().locale, key, vars)
}

function buildTerminalContext(
  prompt: string,
  activeTerminalTab: ReturnType<typeof useTabsStore.getState>['tabs'][number] | undefined
): TerminalContext | undefined {
  if (!activeTerminalTab) return undefined
  const mentionsTerminal = TERMINAL_MENTION.test(prompt)
  return {
    recentOutput: readTerminalOutput(
      activeTerminalTab.id,
      mentionsTerminal ? COPILOT_TERMINAL_MENTION_MAX_LINES : COPILOT_CONTEXT_MAX_LINES
    ),
    host: activeTerminalTab.host,
    username: activeTerminalTab.username,
    cwd: getTabObservation(activeTerminalTab.id)?.cwd
  }
}

/**
 * Send a user prompt to the AI, attaching the active terminal's recent output
 * and host info as context. Ignored while another request is in flight.
 */
export async function sendPrompt(text: string): Promise<void> {
  const prompt = text.trim()
  if (!prompt) return

  const tabId = useAIStore.getState().activeChatTabId
  if (!tabId) return

  // A new instruction while tool actions await approval supersedes them: drop
  // the paused loop and clear busy so this prompt can start a fresh turn.
  if (hasPendingToolCalls(tabId)) cancelPendingApprovals(tabId)

  const ai = useAIStore.getState()
  if (ai.busy) return

  let tab = ai.chatTabs.find((t) => t.id === tabId)
  if (!tab) return

  const activeTerminalTab = useTabsStore.getState().tabs.find(
    (t) => t.id === useTabsStore.getState().activeTabId
  )
  const mentionsTerminal = TERMINAL_MENTION.test(prompt)
  const context = buildTerminalContext(prompt, activeTerminalTab)

  const settings = normalizeAISettings(await window.api.config.getAISettings())
  const limit = resolveActiveContextLength(settings)
  const contextMessage = buildContextMessage(context)
  const userRules = useUserRulesStore.getState().rules
  const budgetParams = {
    systemPrompt: buildEffectiveSystemPrompt(userRules),
    contextMessage,
    draft: prompt,
    limit
  }

  const existingDto: BudgetMessage[] = tab.messages.map((m) => ({
    role: m.role,
    content: m.content
  }))

  const { toCompress } = selectMessagesToCompress(existingDto, budgetParams)
  if (toCompress.length > 0) {
    ai.setBusy(true, null, tabId)
    ai.setNotice(tNotice('copilot.context.compressing'))

    const result = await window.api.ai.compressHistory({
      messages: toCompress as ChatMessageDTO[],
      context
    })

    if (result.error || !result.summary) {
      ai.setBusy(false)
      ai.setNotice(tNotice('copilot.context.compressFailed'))
      return
    }

    const kept = tab.messages.slice(toCompress.length)
    const summaryMsg = {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content: result.summary,
      isContextSummary: true
    }
    ai.replaceMessages(tabId, [summaryMsg, ...kept])
    ai.setNotice(tNotice('copilot.context.compressed', { count: toCompress.length }))

    tab = useAIStore.getState().chatTabs.find((t) => t.id === tabId)
    if (!tab) {
      ai.setBusy(false)
      return
    }
  }

  const history: ChatMessageDTO[] = tab.messages.map((m) => ({
    role: m.role,
    content: m.content
  }))
  history.push({ role: 'user', content: prompt })

  const userId = crypto.randomUUID()

  if (tab.title === DEFAULT_CHAT_TAB_TITLE) {
    ai.renameTab(tabId, autoTitleFromPrompt(prompt))
  }

  ai.updateDraft(tabId, '')
  ai.addMessage(tabId, { id: userId, role: 'user', content: prompt })

  debugLog({
    category: 'user.action',
    tabId,
    message: 'copilot.send',
    data: {
      textLength: prompt.length,
      hasMention: mentionsTerminal,
      boundTabId: mentionsTerminal ? activeTerminalTab?.id : undefined
    }
  })

  // Kick off the function-calling agent loop. startTurn appends the streaming
  // assistant message, wires up the request, and sets the busy flag.
  startTurn({
    tabId,
    context,
    boundSessionId: mentionsTerminal ? activeTerminalTab?.sessionId : undefined,
    boundTabId: mentionsTerminal ? activeTerminalTab?.id : undefined,
    conversation: history,
    guard: createGuardState(),
    // Raw instruction, kept for the Verify step's display-only stop decision.
    userIntent: prompt,
    // Force the chart path only when a terminal is bound to read from.
    chartIntent: mentionsTerminal && !!activeTerminalTab && CHART_INTENT.test(prompt)
  })
}

const MAX_SELECTION = 4000

/**
 * Open the AI panel and ask the copilot to explain the given terminal
 * selection, using the current terminal context.
 */
export function askAboutSelection(selection: string): void {
  const text = selection.trim()
  if (!text) return

  useAIStore.getState().setPanelOpen(true)

  const locale = useLocaleStore.getState().locale
  const clipped =
    text.length > MAX_SELECTION
      ? `${text.slice(0, MAX_SELECTION)}\n${translate(locale, 'copilot.selectionTruncated')}`
      : text
  const prompt = translate(locale, 'copilot.selectionExplain', { selection: clipped })
  void sendPrompt(prompt)
}

/** Estimated token cost of the tool/function schemas sent every turn. */
const TOOLS_DEFINITION_TEXT = JSON.stringify(AI_TOOLS)

/** Build context budget for the active chat tab (for UI meter). */
export function computeActiveTabBudget(params: {
  messages: { role: 'user' | 'assistant'; content: string }[]
  draft: string
  context?: TerminalContext
  limit: number
  userRules?: string
}) {
  // Account for EVERY per-turn injection, not just the terminal context: the app
  // snapshot, skills catalog, task-memory ledger and the tool schemas are all
  // sent each turn and previously went uncounted, understating real usage.
  const activeChatTabId = useAIStore.getState().activeChatTabId
  const overhead = [
    buildContextMessage(params.context),
    buildToolContextMessage(),
    buildSkillsContextMessage(),
    activeChatTabId ? buildTaskMemoryMessage(activeChatTabId) : undefined,
    TOOLS_DEFINITION_TEXT
  ]
    .filter(Boolean)
    .join('\n\n')

  return buildChatPayload({
    systemPrompt: buildEffectiveSystemPrompt(params.userRules ?? ''),
    contextMessage: overhead,
    messages: params.messages,
    draft: params.draft,
    limit: params.limit
  })
}
