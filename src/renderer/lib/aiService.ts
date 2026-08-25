import { useAIStore, DEFAULT_CHAT_TAB_TITLE } from '../store/aiStore'
import { useSessionsStore } from '../store/sessionsStore'
import { COPILOT_CONTEXT_MAX_LINES, COPILOT_TERMINAL_MENTION_MAX_LINES, readTerminalOutput } from './terminalRegistry'
import {
  hasTerminalMention,
  matchTabByMention,
  resolvePinnedTab,
  shouldPinOnSend,
  terminalContextTabId,
  type MentionableTab
} from './pinnedTerminal'
import { getTabObservation } from './terminalObservation'
import { normalizeAISettings, resolveActiveContextLength } from '../../shared/aiSettings'
import {
  buildEffectiveSystemPrompt,
  buildContextMessage,
  buildCopilotSystemPrompt,
  buildUserRulesSystemMessage,
  describeTabOs,
  CHART_INTENT,
  MERMAID_INTENT,
  buildChartTurnNudge,
  type PromptSections
} from '../../shared/prompts'
import {
  buildChatPayload,
  estimateTokens,
  selectMessagesToCompress,
  type BudgetMessage
} from '../../shared/contextBudget'
import { translate } from './i18n/translations'
import { useLocaleStore } from '../store/localeStore'
import { debugLog } from './debugLog'
import {
  buildAITools,
  isAutoApprovedTool,
  isDisplayTool,
  toolNamesFor,
  toolTierForProfile,
  AI_SETTINGS_INTENT,
  type ToolSurfaceOptions,
  type ToolTier
} from '../../shared/aiTools'
import { decideToolCall, DEFAULT_AUTONOMY_MODE } from '../../shared/toolPolicy'
import {
  buildSkillsContextMessage,
  buildToolContextMessage,
  hasEnabledSkills,
  executeToolCall,
  parseToolArgs,
  type ToolResult
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
  reconcileTokens,
  recordTurn,
  turnSignature,
  type GuardState,
  type GuardTrip
} from './loopGuard'
import { buildTaskMemoryMessage } from './taskMemory'
import { compactConversation } from './conversationCompact'
import {
  buildHistoryFromMessages,
  digestToolResult,
  messageBudgetText,
  toolCallContent
} from './toolTrace'
import { buildPlanContextMessage } from './planTool'
import { setToolResultCharBudget } from './toolBudget'
import { transition, type AgentEvent, type AgentPhase } from './agentPhase'
import type { ChatMessage } from '../store/aiStore'
import { useUserRulesStore } from '../store/userRulesStore'
import type {
  AutonomyMode,
  ChatMessageDTO,
  ModelProfile,
  TerminalContext,
  ToolCallView
} from '../../shared/types'

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
  /**
   * Terminal tab the injected context is read from, plus how many lines of its
   * scrollback to include. Kept on the loop so every continuation turn can
   * REBUILD the context instead of resending the snapshot taken before the task
   * started: after a few exec_command calls the cwd and recent output have moved
   * on, while the prompt tells the model exec_command resumes in "the last
   * observed cwd".
   */
  contextTabId?: string
  contextMaxLines?: number
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
   * The user asked to VISUALIZE terminal output as a chart (@host / @terminal + a
   * charting verb). For the first turn we disable function-calling and inject a
   * hard "emit a chart block" nudge: small local models otherwise almost always
   * run the collection command as a tool/bash instead of emitting the ```chart
   * fence, so the two-phase chart pipeline never starts. See sendPrompt.
   */
  chartIntent?: boolean
  /**
   * Whether this task should carry the mermaid authoring rules. Decided once
   * from the opening request and reused, since a diagram normally lands on the
   * last turn of the task rather than the first.
   */
  mermaidIntent?: boolean
  /**
   * Whether this task's request is about AI configuration, so the settings tool
   * carries its full `ai` branch. Decided once and held, like mermaidIntent: the
   * schema for a given tool must not change shape between turns of one task.
   */
  aiSettingsIntent?: boolean
  /**
   * The raw user instruction that kicked off this loop. Used by the Verify step
   * to decide, after a display-only tool turn, whether the request was pure
   * "show me X" (stop once the card is shown) or a "show then act" intent that
   * should keep looping. Set once in sendPrompt and never rewritten by injected
   * nudge/reflection turns, so it always reflects the real intent.
   */
  userIntent?: string
  /** Model context window (tokens), used to bound the conversation in-loop. */
  contextLimit?: number
  /** Tool tier the active profile exposes; its schemas are part of every payload. */
  toolTier?: ToolTier
  /**
   * Tokens the conversation may occupy, recomputed each turn from the window
   * minus everything else in the payload. Cached here so tool results can be
   * capped against the same number when they come back.
   */
  conversationBudget?: number
}

/**
 * Tokens held back for the model's own reply. A context window covers prompt
 * plus generation, so a prompt sized to fill it leaves nothing to answer with.
 */
const OUTPUT_RESERVE_TOKENS = 2048
/** Floor so even a badly configured window leaves room for a step or two. */
const MIN_CONVERSATION_TOKENS = 1024

/**
 * Token cost of the tool schemas, memoized per tier. Constant per tier but far
 * from free — the full tier's 21 schemas measure ~4.5k real tokens, 14% of a
 * 32k window, and none of it was previously counted against any budget.
 */
const toolSchemaTokens = new Map<string, number>()

function toolTokens(tier: ToolTier, surface: ToolSurfaceOptions): number {
  const key = `${tier}:${!!surface.hasSkills}:${!!surface.aiSettingsIntent}`
  const cached = toolSchemaTokens.get(key)
  if (cached !== undefined) return cached
  const tokens = estimateTokens(JSON.stringify(buildAITools(tier, surface)))
  toolSchemaTokens.set(key, tokens)
  return tokens
}

/** The tool surface for a turn, derived from installed config plus its request. */
function toolSurfaceFor(userIntent: string | undefined): ToolSurfaceOptions {
  return {
    hasSkills: hasEnabledSkills(),
    aiSettingsIntent: AI_SETTINGS_INTENT.test(userIntent ?? '')
  }
}

/**
 * Tokens left for the running conversation once everything else in the payload
 * is paid for: system prompt, user rules, terminal context, tool schemas, the
 * skills catalog, and the snapshot/plan/ledger tail.
 *
 * This used to be a flat 50% of the window. That guess ignored the tool schemas
 * entirely and, paired with a token estimate tuned for prose, let a log-heavy
 * turn exceed the window — at which point the server truncated the prompt from
 * the front and rejected the request for having no user message left in it.
 */
function conversationBudget(
  loop: LoopState,
  /** Tier whose schemas ride along, or undefined when tools are disabled. */
  tier: ToolTier | undefined,
  promptSections: PromptSections,
  surface: ToolSurfaceOptions,
  surrounding: ChatMessageDTO[]
): number {
  if (!loop.contextLimit) return 0
  const fixed = [
    buildCopilotSystemPrompt(promptSections),
    buildUserRulesSystemMessage(useUserRulesStore.getState().rules) ?? '',
    buildContextMessage(loop.context) ?? '',
    ...surrounding.map((m) => m.content)
  ].reduce((sum, text) => sum + estimateTokens(text), tier ? toolTokens(tier, surface) : 0)

  const available = loop.contextLimit - fixed - OUTPUT_RESERVE_TOKENS
  if (available < MIN_CONVERSATION_TOKENS) {
    // The floor keeps a cramped window usable for a step or two, but it means
    // the payload is knowingly over budget: everything that is not the
    // conversation already fills the window. Surface it rather than letting the
    // server truncate the prompt from the front (which drops the user's
    // question) and the turn fail for no visible reason.
    useAIStore.getState().setNotice(tNotice('copilot.context.overCommitted'))
    debugLog({
      category: 'action.triggered',
      tabId: loop.tabId,
      message: 'agent.budget.overCommitted',
      data: { contextLimit: loop.contextLimit, fixed, available, floor: MIN_CONVERSATION_TOKENS }
    })
  }
  return Math.max(MIN_CONVERSATION_TOKENS, available)
}

/**
 * Character cap for one tool result. Derived from the conversation budget so a
 * single reply can never crowd out the instruction it is answering, and
 * converted at the dense-content ratio because tool output is command output.
 */
const RESULT_BUDGET_RATIO = 0.3
const DENSE_CHARS_PER_TOKEN = 2
const RESULT_CAP_FLOOR_CHARS = 4000

function perResultCap(budgetTokens: number): number {
  if (budgetTokens <= 0) return RESULT_CAP_FLOOR_CHARS
  return Math.max(
    RESULT_CAP_FLOOR_CHARS,
    Math.floor(budgetTokens * RESULT_BUDGET_RATIO * DENSE_CHARS_PER_TOKEN)
  )
}

function capToolResult(text: string, cap: number): string {
  return `${digestToolResult(text, cap)}\n[result truncated to fit the context window — narrow it with grep, a smaller read_file limit, or head/tail]`
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
/** Prompts typed while a tab was busy, replayed once its loop finishes. */
const queuedPrompts = new Map<string, string[]>()
let initialized = false

/**
 * Autonomy level read from settings. Cached because the approval decision runs
 * synchronously inside the streaming `onDone` handler, which cannot await.
 */
let autonomyMode: AutonomyMode = DEFAULT_AUTONOMY_MODE

/** Tools the user chose to always allow, per chat tab, for this session only. */
const sessionAllowlists = new Map<string, Set<string>>()

export function refreshAutonomyMode(mode: AutonomyMode): void {
  autonomyMode = mode
}

/**
 * Grant a tool blanket approval for the rest of this chat. Scoped to the chat
 * and to this app run: a grant made while fixing one service should not still
 * be in force next week on an unrelated task.
 */
export function allowToolForSession(chatTabId: string, tool: string): void {
  const set = sessionAllowlists.get(chatTabId) ?? new Set<string>()
  set.add(tool)
  sessionAllowlists.set(chatTabId, set)
  debugLog({
    category: 'user.action',
    tabId: chatTabId,
    message: 'tool.approval.allowSession',
    data: { tool }
  })
}

export function isToolAllowedForSession(chatTabId: string, tool: string): boolean {
  return sessionAllowlists.get(chatTabId)?.has(tool) ?? false
}

/** Approval decision for one call, given the current mode and session grants. */
function decideCall(chatTabId: string, name: string, argsJson: string): ReturnType<typeof decideToolCall> {
  return decideToolCall({
    tool: name,
    argsJson,
    mode: autonomyMode,
    sessionAllowlist: sessionAllowlists.get(chatTabId)
  })
}

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
 * Rebuild the loop's terminal context from live state. Leaves the existing
 * context in place if the source tab is gone (closed mid-task), since a stale
 * host/output snippet is still better context than none.
 */
function refreshLoopContext(loop: LoopState): void {
  // A rebind mid-task only takes effect on the next turn: pick up the chat's
  // current pin without aborting a command already in flight.
  const chat = useAIStore.getState().chatTabs.find((t) => t.id === loop.tabId)
  if (chat?.pinnedTabId && chat.pinnedTabId !== loop.contextTabId) {
    const terminal = useSessionsStore.getState().sessions.find((t) => t.id === chat.pinnedTabId)
    if (terminal) {
      loop.contextTabId = terminal.id
      loop.boundTabId = terminal.id
      loop.boundSessionId = terminal.sessionId
    }
  }
  if (!loop.contextTabId) return
  const fresh = readTabContext(loop.contextTabId, loop.contextMaxLines ?? COPILOT_CONTEXT_MAX_LINES)
  if (fresh) loop.context = fresh
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
  // Re-read the terminal before every turn. The snapshot taken when the task
  // started goes stale the moment the agent runs a command, and a stale `cwd` is
  // actively misleading given exec_command resumes in the last observed one.
  refreshLoopContext(loop)
  // A chart-visualization request only applies to the FIRST turn: emit the
  // ```chart fence with tools OFF (below), then the loop is done — there is no
  // continuation to keep nudging.
  const firstTurn = loop.phase === undefined
  const chartTurn = !!loop.chartIntent && firstTurn
  // Only assemble the prompt sections this turn actually needs: the long chart
  // rules ride along only on the (first) chart turn, and mermaid rules only when
  // the request asked for a diagram. A chart turn sends no tools, so it is
  // charged for no tool rules either.
  //
  // The mermaid decision is made from the request that opened the loop and then
  // held for the whole task. It is deliberately NOT re-derived from the latest
  // user message: a diagram is usually emitted at the END of a multi-step task,
  // by which point the newest user-role message is an injected nudge rather than
  // the request — testing that would drop the rules exactly when they are due.
  // A genuinely new instruction supersedes the loop, so it arrives as a new one.
  loop.mermaidIntent ??= !chartTurn && MERMAID_INTENT.test(loop.userIntent ?? '')
  loop.aiSettingsIntent ??= AI_SETTINGS_INTENT.test(loop.userIntent ?? '')
  const toolSurface = {
    hasSkills: hasEnabledSkills(),
    aiSettingsIntent: loop.aiSettingsIntent
  }
  const promptSections: PromptSections = {
    chart: chartTurn,
    mermaid: loop.mermaidIntent,
    toolNames: chartTurn ? [] : toolNamesFor(loop.toolTier ?? 'full', toolSurface)
  }
  const skillsCatalog = buildSkillsContextMessage()
  // Prefix layer: near-constant across the task, so it stays at the front where
  // provider prefix caches can reuse it.
  const prefix: ChatMessageDTO[] = []
  if (skillsCatalog) prefix.push({ role: 'system', content: skillsCatalog })

  // Suffix layer: everything that changes every turn (live app snapshot, the
  // task plan, the ledger of completed actions). Keeping it AFTER the
  // conversation both preserves the cacheable prefix and gives these facts
  // recency over the long system prompt.
  const suffix: ChatMessageDTO[] = []
  const chat = ai.chatTabs.find((t) => t.id === loop.tabId)
  const snapshot = buildToolContextMessage(loop.toolTier, chat?.pinnedTabId)
  const plan = buildPlanContextMessage(loop.tabId)
  const taskMemory = buildTaskMemoryMessage(loop.tabId)
  if (snapshot) suffix.push({ role: 'system', content: snapshot })
  if (taskMemory) suffix.push({ role: 'system', content: taskMemory })
  if (plan) suffix.push({ role: 'system', content: plan })

  // Bound the running conversation with what is actually left over, which is
  // why the surrounding layers are assembled first.
  if (loop.contextLimit) {
    const budget = conversationBudget(
      loop,
      chartTurn ? undefined : loop.toolTier ?? 'full',
      promptSections,
      toolSurface,
      [...prefix, ...suffix]
    )
    loop.conversationBudget = budget
    setToolResultCharBudget(perResultCap(budget))
    const compacted = compactConversation(loop.conversation, budget)
    if (compacted.trimmed > 0 || compacted.dropped > 0 || compacted.condensed > 0) {
      loop.conversation = compacted.messages
      debugLog({
        category: 'action.triggered',
        tabId: loop.tabId,
        message: 'agent.compact',
        data: {
          trimmed: compacted.trimmed,
          dropped: compacted.dropped,
          condensed: compacted.condensed,
          budget
        }
      })
    }
  }

  const messages: ChatMessageDTO[] = [...prefix, ...loop.conversation, ...suffix]
  // Append the chart nudge as the LAST (trailing user) message: recency beats
  // the large tool-oriented system prompt, which otherwise wins and the model
  // answers with a bare bash block. It is NOT written back to loop.conversation,
  // so it never leaks into persisted history or later turns.
  if (chartTurn) {
    messages.push({
      role: 'user',
      content: buildChartTurnNudge(useLocaleStore.getState().locale)
    })
  }

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
    promptSections,
    aiSettingsIntent: loop.aiSettingsIntent
  })
}

/**
 * Cancellers for commands currently running on behalf of a chat tab. Stop needs
 * these because aborting the LLM stream leaves the remote command running.
 */
const runningCommandAborts = new Map<string, Set<() => void>>()

/** Pause before the single automatic retry of a transiently failed call. */
const RETRY_BACKOFF_MS = 1500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function registerCommandAbort(tabId: string, abort: () => void): () => void {
  const set = runningCommandAborts.get(tabId) ?? new Set<() => void>()
  set.add(abort)
  runningCommandAborts.set(tabId, set)
  return () => {
    set.delete(abort)
    if (set.size === 0) runningCommandAborts.delete(tabId)
  }
}

/** Execute a single tool call and record its outcome, then advance the loop. */
async function runToolCall(
  tabId: string,
  messageId: string,
  callId: string,
  opts?: { deferContinue?: boolean }
): Promise<void> {
  const ai = useAIStore.getState()
  const call = findMessage(tabId, messageId)?.toolCalls?.find((c) => c.id === callId)
  if (!call) return
  if (!isAutoApprovedTool(call.name)) {
    const loop = loops.get(messageId)
    if (loop) loop.executedActionTool = true
  }

  // Arguments that do not parse are reported as such. Silently substituting an
  // empty object made the model chase a phantom "missing tab_id" instead of the
  // real problem, which was its own malformed JSON.
  const parsed = parseToolArgs(call.args)
  if (!parsed.ok) {
    ai.updateToolCall(tabId, messageId, callId, {
      status: 'error',
      error: parsed.error,
      digest: digestToolResult(`Error: ${parsed.error}`)
    })
    if (!opts?.deferContinue) maybeContinueLoop(tabId, messageId)
    return
  }

  ai.updateToolCall(tabId, messageId, callId, { status: 'running' })
  debugLog({
    category: 'action.triggered',
    tabId,
    message: `tool.${call.name}`,
    data: { args: parsed.args }
  })
  let unregisterAbort: (() => void) | undefined
  const chat = ai.chatTabs.find((t) => t.id === tabId)
  try {
    const invoke = (): Promise<ToolResult> =>
      executeToolCall(call.name, parsed.args, {
        chatTabId: tabId,
        pinnedTabId: chat?.pinnedTabId,
        onCaptureProgress:
          call.name === 'exec_command' || call.name === 'run_in_terminal'
            ? (elapsedMs) => {
                ai.updateToolCall(tabId, messageId, callId, { progressMs: elapsedMs })
              }
            : undefined,
        onAbortHandle: (abort) => {
          unregisterAbort = registerCommandAbort(tabId, abort)
        }
      })

    let res = await invoke()
    let retryNote = ''

    // Transient failures (a timeout, a lock still held, a service still coming
    // up) are far cheaper to retry here than to round-trip through the model,
    // which would spend a full turn deciding to do exactly this. One retry
    // only — a second failure is a real failure the model should reason about.
    if (res.retryable) {
      debugLog({ category: 'action.triggered', tabId, message: `tool.${call.name}.retry`, data: {} })
      await delay(RETRY_BACKOFF_MS)
      const retried = await invoke()
      retryNote = `\nnote: the first attempt failed transiently; this is an automatic retry after ${RETRY_BACKOFF_MS}ms.`
      res = retried
    }

    debugLog({
      category: 'action.triggered',
      tabId,
      message: `tool.${call.name}.result`,
      data: { ok: res.ok, result: res.ok ? res.result : res.error }
    })
    // The digest is captured now, while the full result is in hand: it is what
    // this call contributes to the conversation on every later user turn, and
    // it must survive a restart even though the raw result may be trimmed.
    if (res.ok) {
      const result = `${res.result ?? 'Done.'}${retryNote}`
      ai.updateToolCall(tabId, messageId, callId, {
        status: 'done',
        result,
        digest: digestToolResult(result)
      })
    } else {
      const error = `${res.error ?? 'unknown error'}${retryNote}`
      ai.updateToolCall(tabId, messageId, callId, {
        status: 'error',
        error,
        digest: digestToolResult(`Error: ${error}`)
      })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ai.updateToolCall(tabId, messageId, callId, {
      status: 'error',
      error: message,
      digest: digestToolResult(`Error: ${message}`)
    })
  } finally {
    unregisterAbort?.()
  }
  if (!opts?.deferContinue) maybeContinueLoop(tabId, messageId)
}

/**
 * Run a turn's auto-approved calls. Read-only calls go out together because
 * they cannot interfere with each other; anything that mutates runs one at a
 * time so two edits to the same file cannot interleave. The loop is advanced
 * once, after the whole batch settles, instead of once per call.
 */
async function runAutoToolCalls(tabId: string, messageId: string, callIds: string[]): Promise<void> {
  const calls = findMessage(tabId, messageId)?.toolCalls ?? []
  const byId = new Map(calls.map((c) => [c.id, c]))
  const readonly = callIds.filter((id) => isAutoApprovedTool(byId.get(id)?.name ?? ''))
  const mutating = callIds.filter((id) => !readonly.includes(id))

  await Promise.all(readonly.map((id) => runToolCall(tabId, messageId, id, { deferContinue: true })))
  for (const id of mutating) {
    await runToolCall(tabId, messageId, id, { deferContinue: true })
  }
  maybeContinueLoop(tabId, messageId)
}

/**
 * Stop everything this chat tab has in flight: the LLM stream, any remote
 * command it started, and the ReAct loop itself. Cancelling only the stream
 * (the old behaviour) left the command running on the host and the loop ready
 * to resume the moment that command returned.
 */
export function abortLoop(tabId: string): void {
  const ai = useAIStore.getState()
  queuedPrompts.delete(tabId)

  for (const [requestId, entry] of pending) {
    if (entry.tabId !== tabId) continue
    window.api.ai.cancel(requestId)
    pending.delete(requestId)
    loops.delete(entry.messageId)
  }

  for (const abort of runningCommandAborts.get(tabId) ?? []) {
    try {
      abort()
    } catch {
      // A canceller for an already-finished command is not worth reporting.
    }
  }
  runningCommandAborts.delete(tabId)

  const tab = ai.chatTabs.find((t) => t.id === tabId)
  for (const msg of tab?.messages ?? []) {
    if (msg.streaming) ai.finishMessage(tabId, msg.id)
    for (const call of msg.toolCalls ?? []) {
      if (call.status !== 'pending' && call.status !== 'running') continue
      ai.updateToolCall(tabId, msg.id, call.id, {
        status: 'rejected',
        result: 'Cancelled by the user.',
        digest: 'Cancelled by the user.'
      })
    }
    loops.delete(msg.id)
  }

  debugLog({ category: 'user.action', tabId, message: 'agent.abort', data: {} })
  ai.setBusy(false)
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
    result: 'User rejected this action.',
    digest: 'User rejected this action.'
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
      result: 'Superseded by a new instruction.',
      digest: 'Superseded by a new instruction.'
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
  const resultCap = perResultCap(loop.conversationBudget ?? 0)
  for (const c of calls) {
    const raw = toolCallContent(c)
    // Bound each result as it enters the conversation. Compaction runs before
    // the next turn and would catch this too, but capping at the door keeps the
    // model from ever seeing a reply so large it crowds out the instruction it
    // was answering — and it applies to any tool, including an exec_command
    // that happened to `cat` a log.
    const content = raw.length > resultCap ? capToolResult(raw, resultCap) : raw
    loop.conversation.push({ role: 'tool', tool_call_id: c.id, content })
    signatureCalls.push({ name: c.name, args: c.args, result: content })
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

  // Replay whatever the user typed while the previous task was still running.
  // Watching the busy flag covers every way a loop can end (final answer, guard
  // trip, error, abort) without threading a callback through all of them.
  useAIStore.subscribe((state, prev) => {
    if (!prev.busy || state.busy) return
    for (const [tabId, queue] of queuedPrompts) {
      if (queue.length === 0) {
        queuedPrompts.delete(tabId)
        continue
      }
      const next = queue.shift() as string
      if (queue.length === 0) queuedPrompts.delete(tabId)
      void sendPrompt(next, tabId)
      return
    }
  })

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
  window.api.ai.onDone(({ requestId, content, toolCalls, usage }) => {
    const entry = pending.get(requestId)
    pending.delete(requestId)
    if (!entry) {
      useAIStore.getState().setBusy(false)
      return
    }
    const { tabId, messageId, loop, epilogue } = entry
    const ai = useAIStore.getState()

    // Swap this turn's estimate for the provider's real count before the guard
    // checks the task budget below.
    if (usage && loop.guard) reconcileTokens(loop.guard, usage.total)

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
    const decisions = toolCalls.map((tc) => decideCall(tabId, tc.name, tc.arguments))
    const views: ToolCallView[] = toolCalls.map((tc, i) => ({
      id: tc.id,
      name: tc.name,
      args: tc.arguments,
      status: decisions[i] === 'auto' ? 'running' : 'pending'
    }))
    ai.setToolCalls(tabId, messageId, views)
    loops.set(messageId, loop)

    if (views.some((v) => v.status === 'pending')) advance(loop, 'needApproval', tabId)

    // A 'deny' decision is refused outright rather than offered for approval:
    // conservative mode exists precisely so a destructive command is never one
    // stray click away.
    toolCalls.forEach((tc, i) => {
      if (decisions[i] !== 'deny') return
      ai.updateToolCall(tabId, messageId, tc.id, {
        status: 'rejected',
        result: 'Blocked by the current autonomy policy: this command is destructive.',
        digest: 'Blocked by the current autonomy policy: this command is destructive.'
      })
    })
    const autoIds = toolCalls.filter((_, i) => decisions[i] === 'auto').map((tc) => tc.id)
    if (autoIds.length > 0) void runAutoToolCalls(tabId, messageId, autoIds)
    else maybeContinueLoop(tabId, messageId)
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

const TAB_TITLE_MAX = 24

function autoTitleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= TAB_TITLE_MAX) return oneLine
  return oneLine.slice(0, TAB_TITLE_MAX) + '…'
}

function tNotice(key: Parameters<typeof translate>[1], vars?: Record<string, string | number>): string {
  return translate(useLocaleStore.getState().locale, key, vars)
}

/** How much scrollback to include: an explicit @host / @terminal mention asks for more. */
function contextMaxLines(prompt: string, tabs: readonly MentionableTab[]): number {
  return hasTerminalMention(prompt, tabs)
    ? COPILOT_TERMINAL_MENTION_MAX_LINES
    : COPILOT_CONTEXT_MAX_LINES
}

/** Read a tab's live context (output window, host identity, observed cwd). */
function readTabContext(tabId: string, maxLines: number): TerminalContext | undefined {
  const tab = useSessionsStore.getState().sessions.find((t) => t.id === tabId)
  if (!tab) return undefined
  return {
    recentOutput: readTerminalOutput(tab.id, maxLines),
    host: tab.host,
    username: tab.username,
    osHint: describeTabOs(tab.kind, tab.wslDistro),
    cwd: getTabObservation(tab.id)?.cwd
  }
}

/**
 * Send a user prompt to the AI, attaching the pinned terminal's recent output
 * and host info as context. Ignored while another request is in flight.
 */
export async function sendPrompt(text: string, targetTabId?: string): Promise<void> {
  const prompt = text.trim()
  if (!prompt) return

  const tabId = targetTabId ?? useAIStore.getState().activeChatTabId
  if (!tabId) return

  // A new instruction while tool actions await approval supersedes them: drop
  // the paused loop and clear busy so this prompt can start a fresh turn.
  if (hasPendingToolCalls(tabId)) cancelPendingApprovals(tabId)

  const ai = useAIStore.getState()

  // A prompt sent mid-task is queued and replayed when the loop finishes.
  // Dropping it (the old behaviour) looked identical to a broken Send button.
  if (ai.busy) {
    const queue = queuedPrompts.get(tabId) ?? []
    queue.push(prompt)
    queuedPrompts.set(tabId, queue)
    ai.setNotice(tNotice('copilot.queued', { count: queue.length }))
    return
  }

  let tab = ai.chatTabs.find((t) => t.id === tabId)
  if (!tab) return

  const terminals = useSessionsStore.getState()
  const activeTerminalId = terminals.activeSessionId
  const mentionedTab = !tab.pinnedTabId ? matchTabByMention(prompt, terminals.sessions) : undefined
  const nextPinId = mentionedTab?.id ?? shouldPinOnSend(tab.pinnedTabId, activeTerminalId)
  if (nextPinId && nextPinId !== tab.pinnedTabId) {
    ai.setPinnedTerminal(tabId, nextPinId)
    tab = { ...tab, pinnedTabId: nextPinId }
  }

  const pin = resolvePinnedTab(
    tab.pinnedTabId,
    tab.pinnedLabel,
    terminals.sessions.map((t) => t.id)
  )
  const contextTabId = terminalContextTabId(pin, activeTerminalId)
  const contextTab = contextTabId
    ? terminals.sessions.find((t) => t.id === contextTabId)
    : undefined
  const mentionsTerminal = hasTerminalMention(prompt, terminals.sessions)
  const context = contextTabId ? readTabContext(contextTabId, contextMaxLines(prompt, terminals.sessions)) : undefined

  const settings = normalizeAISettings(await window.api.config.getAISettings())
  const limit = resolveActiveContextLength(settings)
  refreshAutonomyMode(settings.copilotAutonomy)
  const userRules = useUserRulesStore.getState().rules
  const tier = toolTierForProfile(settings.copilotModelProfile)
  // Force the chart path only when a terminal is bound to read from.
  const chartIntent = mentionsTerminal && !!contextTab && CHART_INTENT.test(prompt)
  const boundTabId = pin.status === 'live' ? pin.tabId : contextTab?.id
  const boundSessionId = boundTabId
    ? terminals.sessions.find((t) => t.id === boundTabId)?.sessionId
    : undefined

  // Decide compression against what this turn will ACTUALLY send: the sections
  // and tool set for the active tier, plus every per-turn injection. Estimating
  // from the full worst-case prompt moved the threshold for trimmed tiers.
  const surface = toolSurfaceFor(prompt)
  const budgetParams = {
    systemPrompt: buildEffectiveSystemPrompt(userRules, {
      chart: chartIntent,
      mermaid: MERMAID_INTENT.test(prompt),
      // A chart turn disables function calling, so it is charged for no tools.
      toolNames: chartIntent ? [] : toolNamesFor(tier, surface)
    }),
    contextMessage: fixedOverheadText(context, tabId, chartIntent ? undefined : tier, surface),
    draft: prompt,
    limit
  }

  // Size each message by everything it will actually replay — prose plus its
  // tool arguments and result digests. Kept index-aligned with `tab.messages`
  // so the compression decision below can be applied back by position.
  const existingDto: BudgetMessage[] = tab.messages.map((m) => ({
    role: m.role,
    content: messageBudgetText(m)
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

  // Replay the full chain (assistant tool_calls + their paired tool results),
  // not just the visible prose: without it the model cannot see any command it
  // ran, so every follow-up turn starts from amnesia.
  const history = buildHistoryFromMessages(tab.messages)
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
      boundTabId
    }
  })

  // Kick off the function-calling agent loop. startTurn appends the streaming
  // assistant message, wires up the request, and sets the busy flag.
  startTurn({
    tabId,
    context,
    contextTabId,
    contextMaxLines: contextMaxLines(prompt, terminals.sessions),
    boundSessionId,
    boundTabId,
    conversation: history,
    contextLimit: limit,
    toolTier: tier,
    guard: createGuardState(),
    // Raw instruction, kept for the Verify step's display-only stop decision.
    userIntent: prompt,
    chartIntent
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
  const chatId = useAIStore.getState().activeChatTabId
  const activeTerminalId = useSessionsStore.getState().activeSessionId
  if (chatId && activeTerminalId) {
    useAIStore.getState().setPinnedTerminal(chatId, activeTerminalId)
  }
  void sendPrompt(prompt)
}

/**
 * Estimated token cost of the tool/function schemas sent every turn. Which
 * schemas are sent depends on the model tier and on whether skills exist, so the
 * meter is charged for the surface actually in use rather than the full set.
 * Cached per surface because the JSON is rebuilt on every keystroke of the
 * draft, and it never changes for a given surface.
 */
const toolsDefinitionCache = new Map<string, string>()

function toolsDefinitionText(tier: ToolTier, surface: ToolSurfaceOptions): string {
  const key = `${tier}:${!!surface.hasSkills}:${!!surface.aiSettingsIntent}`
  let text = toolsDefinitionCache.get(key)
  if (text === undefined) {
    text = JSON.stringify(buildAITools(tier, surface))
    toolsDefinitionCache.set(key, text)
  }
  return text
}

/**
 * Everything a turn pays for besides the running conversation: the per-turn
 * context injections plus the tool schemas.
 *
 * Account for EVERY per-turn injection, not just the terminal context — the app
 * snapshot, skills catalog, task-memory ledger and the tool schemas all ride
 * along on each turn. Shared by the UI meter and the pre-turn compression
 * decision so the two cannot disagree about how much of the window is already
 * spoken for.
 */
function fixedOverheadText(
  context: TerminalContext | undefined,
  chatTabId: string | undefined,
  /** Tier whose schemas ride along, or undefined when tools are disabled. */
  tier: ToolTier | undefined,
  surface: ToolSurfaceOptions
): string {
  return [
    buildContextMessage(context),
    buildToolContextMessage(tier, chatTabId ? useAIStore.getState().chatTabs.find((t) => t.id === chatTabId)?.pinnedTabId : undefined),
    buildSkillsContextMessage(),
    chatTabId ? buildTaskMemoryMessage(chatTabId) : undefined,
    buildPlanContextMessage(chatTabId),
    tier ? toolsDefinitionText(tier, surface) : undefined
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Build context budget for the active chat tab (for UI meter). */
export function computeActiveTabBudget(params: {
  messages: { role: 'user' | 'assistant'; content: string }[]
  draft: string
  context?: TerminalContext
  limit: number
  userRules?: string
  /** Active copilot model profile; decides how large a tool schema is sent. */
  profile?: ModelProfile
}) {
  const activeChatTabId = useAIStore.getState().activeChatTabId ?? undefined
  const tier = toolTierForProfile(params.profile)
  // A gauge should read the fullest the next turn could get, so it assumes the
  // optional sections and the heavyweight settings schema all ride along.
  const surface: ToolSurfaceOptions = { hasSkills: hasEnabledSkills(), aiSettingsIntent: true }

  return buildChatPayload({
    // The meter is a headroom gauge, so it keeps the worst-case chart+mermaid
    // sections — but scoped to the tier's tools, since a trimmed tier can never
    // be charged for schemas and rules it does not receive.
    systemPrompt: buildEffectiveSystemPrompt(params.userRules ?? '', {
      chart: true,
      mermaid: true,
      toolNames: toolNamesFor(tier, surface)
    }),
    contextMessage: fixedOverheadText(params.context, activeChatTabId, tier, surface),
    messages: params.messages,
    draft: params.draft,
    limit: params.limit
  })
}
