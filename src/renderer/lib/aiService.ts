import {
  useAIStore,
  DEFAULT_CHAT_TAB_TITLE,
  isChatBusy,
  unreachableBusyTabs
} from '../store/aiStore'
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
import { compactConversation, planCompaction } from './conversationCompact'
import {
  buildHistoryFromMessages,
  digestToolResult,
  messageBudgetText,
  toolCallContent
} from './toolTrace'
import { buildPlanContextMessage } from './planTool'
import { claimVerifyCheckpoint, recordTaskEvidence, taskEvidence } from './taskEvidence'
import { unmetPlanSteps, unmetStepsPrompt } from '../../shared/planVerify'
import { parseExecToolResult, parsedExitCode } from './execResult'
import { buildHostMemoryMessage, loadHostMemory } from './hostMemory'
import { setToolResultCharBudget } from './toolBudget'
import { refreshCommandTimeoutMinutes } from './execCapture'
import { transition, type AgentEvent, type AgentPhase } from './agentPhase'
import { planRecovery, planTruncationRecovery } from './turnRecovery'
import type { ChatMessage } from '../store/aiStore'
import { extractFileMentionPaths, expandMentionPath } from './fileMentions'
import { readFile } from './fileTools'
import { useUserRulesStore } from '../store/userRulesStore'
import type {
  AISettings,
  AutonomyMode,
  ChatMessageDTO,
  CopilotAgentMode,
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
  /**
   * Our estimate of the prompt the turn in flight carries, tools and system
   * prompt included. Reported alongside an over-window failure so the log says
   * how large the refused payload was.
   */
  promptEstimate?: number
  /** Tool tier the active profile exposes; its schemas are part of every payload. */
  toolTier?: ToolTier
  /**
   * Tokens the conversation may occupy, recomputed each turn from the window
   * minus everything else in the payload. Cached here so tool results can be
   * capped against the same number when they come back.
   */
  conversationBudget?: number
  /**
   * File bodies injected from @path on the opening send. Held for the task so
   * continuation turns still see what the user mentioned.
   */
  fileContext?: string
  /**
   * True once the user interrupted a running command (Ctrl+C in the terminal).
   * The loop then does a tools-off summary turn instead of continuing to act.
   */
  interruptedByUser?: boolean
  /** Tools-off recap turn after a user interrupt. */
  summarizeOnly?: boolean
  /** LLM summaries folded into this task's history so far. */
  loopSummaries?: number
  /** Set by `abortLoop` while the loop is parked on an async summarization. */
  aborted?: boolean
  /**
   * Automatic retries this task has already spent, counted per failure class
   * because the answer to each is different and so is the evidence that it did
   * not work. A second identical over-window failure means compacting is not
   * the fix; a second timeout might still just be a slow endpoint.
   */
  contextRecoveries?: number
  transientRetries?: number
  truncationRetries?: number
  /**
   * Multiplier applied to the conversation budget for the rest of this task,
   * lowered once the provider has been seen to CUT a reply at the output limit.
   * The window is not wrong in that case — the split between prompt and answer
   * is, and this is the only knob that moves it.
   */
  budgetSqueeze?: number
}

/**
 * Tokens held back for the model's own reply. A context window covers prompt
 * plus generation, so a prompt sized to fill it leaves nothing to answer with.
 *
 * This was 2048, which is less than a reasoning model spends thinking its way
 * through one file write (7k observed on a single `write_file` turn). Reserving
 * less than the answer needs does not produce a smaller answer — the provider
 * clamps the completion instead, the reply arrives cut off mid-sentence, and a
 * cut-off reply carries no tool call, so the loop stalls one turn short of
 * finishing with no error anywhere.
 */
const OUTPUT_RESERVE_MAX = 8192
const OUTPUT_RESERVE_MIN = 2048
/** A small window cannot hand a quarter of itself to the reserve and still work. */
const OUTPUT_RESERVE_SHARE = 0.25
/** Floor so even a badly configured window leaves room for a step or two. */
const MIN_CONVERSATION_TOKENS = 1024

function outputReserveTokens(limit = 0): number {
  if (limit <= 0) return OUTPUT_RESERVE_MAX
  const share = Math.floor(limit * OUTPUT_RESERVE_SHARE)
  return Math.max(OUTPUT_RESERVE_MIN, Math.min(OUTPUT_RESERVE_MAX, share))
}

/**
 * Hand part of the conversation's budget back to the answer. Only ever below 1,
 * and only after the provider has been observed cutting a reply short: the
 * reserve is a guess about how much the model wants to say, and this is the
 * correction when that guess is measured wrong.
 */
function squeezeBudget(budget: number, squeeze = 1): number {
  if (budget <= 0 || squeeze >= 1) return budget
  return Math.max(MIN_CONVERSATION_TOKENS, Math.floor(budget * squeeze))
}

/**
 * Token cost of the tool schemas, memoized per tier. Constant per tier but far
 * from free — the full tier's 21 schemas measure ~4.5k real tokens, 14% of a
 * 32k window, and none of it was previously counted against any budget.
 */
const toolSchemaTokens = new Map<string, number>()

function toolSurfaceKey(tier: ToolTier, surface: ToolSurfaceOptions): string {
  return `${tier}:${!!surface.hasSkills}:${!!surface.aiSettingsIntent}:${!!surface.planMode}:${!!surface.executeMode}`
}

function toolTokens(tier: ToolTier, surface: ToolSurfaceOptions): number {
  const key = toolSurfaceKey(tier, surface)
  const cached = toolSchemaTokens.get(key)
  if (cached !== undefined) return cached
  const tokens = estimateTokens(JSON.stringify(buildAITools(tier, surface)))
  toolSchemaTokens.set(key, tokens)
  return tokens
}

/** Tokens the running conversation contributes, tool-call arguments included. */
function conversationTokens(messages: readonly ChatMessageDTO[]): number {
  let sum = 0
  for (const m of messages) {
    sum += estimateTokens(m.content)
    for (const call of m.tool_calls ?? []) sum += estimateTokens(call.arguments)
  }
  return sum
}

/**
 * Fold the per-turn state injections (app snapshot, task ledger, plan, mentioned
 * files) into ONE trailing message, and send it as `user` rather than `system`.
 *
 * These used to be three or four separate trailing `system` messages, which
 * made every request end on a system turn. Two things go wrong with that. The
 * mundane one is recency: a chat template gives the last turn the most weight,
 * and spending that position on a header the model has already seen twenty
 * times wastes it. The one that broke a task is that several OpenAI-compatible
 * backends reject the shape outright — an Ollama-served Qwen3 refuses a
 * conversation whose surviving tail is system-only with "no user query found in
 * messages", which is exactly what its own front-truncation produces from a
 * request like this. Handing the state over as a user turn is both the honest
 * framing (the app is speaking, not the model) and a shape every backend takes.
 *
 * The label matters: without it a model treats the snapshot as something the
 * human typed and starts answering it.
 */
function buildTurnStateMessage(sections: (string | undefined)[]): ChatMessageDTO[] {
  const body = sections.filter((s): s is string => !!s && s.trim().length > 0)
  if (body.length === 0) return []
  return [
    {
      role: 'user',
      content: `[Injected by the app, not typed by the user: live state for THIS turn. Read it, do not reply to it.]\n\n${body.join(
        '\n\n'
      )}`
    }
  ]
}

function chatAgentMode(tabId: string): CopilotAgentMode {
  return useAIStore.getState().chatTabs.find((t) => t.id === tabId)?.agentMode ?? 'agent'
}

/** The tool surface for a turn, derived from installed config plus its request. */
function toolSurfaceFor(
  userIntent: string | undefined,
  agentMode: CopilotAgentMode = 'agent'
): ToolSurfaceOptions {
  return {
    hasSkills: hasEnabledSkills(),
    aiSettingsIntent: AI_SETTINGS_INTENT.test(userIntent ?? ''),
    planMode: agentMode === 'plan',
    executeMode: agentMode === 'execute'
  }
}

function isPlanMode(tabId: string): boolean {
  return chatAgentMode(tabId) === 'plan'
}

function syncQueueCount(tabId: string): void {
  const n = queuedPrompts.get(tabId)?.length ?? 0
  useAIStore.getState().setQueuedCount(tabId, n)
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
  /** Configured context window for this turn. */
  limit: number,
  /** Tier whose schemas ride along, or undefined when tools are disabled. */
  tier: ToolTier | undefined,
  promptSections: PromptSections,
  surface: ToolSurfaceOptions,
  surrounding: ChatMessageDTO[]
): { budget: number; fixed: number } {
  const fixed = [
    buildCopilotSystemPrompt(promptSections),
    buildUserRulesSystemMessage(useUserRulesStore.getState().rules) ?? '',
    buildContextMessage(loop.context) ?? '',
    ...surrounding.map((m) => m.content)
  ].reduce((sum, text) => sum + estimateTokens(text), tier ? toolTokens(tier, surface) : 0)
  if (!limit) return { budget: 0, fixed }

  const available = limit - fixed - outputReserveTokens(limit)
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
      data: { contextLimit: limit, fixed, available, floor: MIN_CONVERSATION_TOKENS }
    })
  }
  return { budget: Math.max(MIN_CONVERSATION_TOKENS, available), fixed }
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

/** Output retained per command for assertion matching. Never sent to a model. */
const EVIDENCE_OUTPUT_CHARS = 4000

/**
 * Record what a shell command actually did, so a plan step's verify assertion
 * is checked against the transcript rather than against the model's account of
 * it. Only the exec tools qualify: an assertion is a command that ran, and the
 * whole point is that the evidence is independent of what the model claims.
 */
function recordExecEvidence(loop: LoopState, call: ToolCallView, result: string): void {
  if (call.name !== 'exec_command' && call.name !== 'run_in_terminal') return
  if (call.status !== 'done') return
  let command: string
  try {
    const args = JSON.parse(call.args) as { command?: unknown }
    if (typeof args.command !== 'string' || !args.command.trim()) return
    command = args.command
  } catch {
    return
  }
  const parsed = parseExecToolResult(result)
  recordTaskEvidence(loop.tabId, {
    command,
    exitCode: parsedExitCode(parsed.exitCode),
    output: parsed.output.slice(0, EVIDENCE_OUTPUT_CHARS)
  })
}

/**
 * Loops parked mid-task on something asynchronous: a history summarization, or
 * the backoff before an automatic retry. They are in neither `pending` nor
 * `loops` at that moment, so without this Stop would have nothing to cancel and
 * the turn would resume after the user asked it not to — and the busy sweeper
 * would count the chat as unreachable and free its composer under it.
 */
const parked = new Map<string, LoopState>()

/**
 * Cap on summarizations per task. Each one costs a round trip, and a loop that
 * needs a fourth has a problem no amount of summarizing will fix — from there
 * the local compactor takes over and the loop guard ends the task.
 */
const MAX_LOOP_SUMMARIES = 3

/**
 * Summarize the steps local compaction is about to delete, one turn before it
 * deletes them.
 *
 * The local compactor's second pass drops whole turns, and a dropped turn takes
 * its exit codes and file paths with it — so the agent re-runs the command it
 * already ran, or edits the file it already edited. Trading one LLM call for a
 * record of those steps is worth it precisely when it is needed: only on the
 * turn the budget would otherwise force a deletion.
 *
 * Budget comes from the previous turn's `conversationBudget`, which is what it
 * is cached for. It is an estimate for one turn ahead, and it does not need to
 * be better than that: being wrong means the local compactor runs anyway.
 */
async function maybeSummarizeLoopHistory(loop: LoopState): Promise<void> {
  const budget = loop.conversationBudget
  if (!budget || (loop.loopSummaries ?? 0) >= MAX_LOOP_SUMMARIES) return
  const plan = planCompaction(loop.conversation, budget)
  if (plan.dropCount === 0) return

  const doomed = loop.conversation.slice(plan.headLength, plan.dropThrough)
  if (doomed.length === 0) return

  const ai = useAIStore.getState()
  ai.setNotice(tNotice('copilot.context.compressing'))
  parked.set(loop.tabId, loop)
  let result: { summary?: string; error?: string }
  try {
    result = await window.api.ai.compressHistory({
      messages: doomed,
      context: loop.context,
      mode: 'loop'
    })
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e) }
  } finally {
    parked.delete(loop.tabId)
  }
  if (loop.aborted) return

  if (result.error || !result.summary) {
    // Falling through to the local compactor is the right failure: a degraded
    // conversation still runs, and a summarizer outage must not end the task.
    debugLog({
      category: 'action.triggered',
      tabId: loop.tabId,
      message: 'agent.loopCompact.failed',
      data: { error: result.error, steps: plan.dropCount }
    })
    return
  }

  loop.loopSummaries = (loop.loopSummaries ?? 0) + 1
  loop.conversation = [
    ...loop.conversation.slice(0, plan.headLength),
    {
      role: 'system',
      content: `[Record of ${plan.dropCount} earlier step(s) in this task, summarized to stay within the context window. Treat it as fact: these steps DID run — do not repeat them unless you need fresh state.]\n\n${result.summary}`
    },
    ...loop.conversation.slice(plan.dropThrough)
  ]
  debugLog({
    category: 'action.triggered',
    tabId: loop.tabId,
    message: 'agent.loopCompact',
    data: { steps: plan.dropCount, summaryChars: result.summary.length, budget }
  })
}

/** Continue the loop, summarizing first when the budget is about to bite. */
function continueLoop(loop: LoopState, epilogue = false): void {
  void maybeSummarizeLoopHistory(loop).then(() => {
    if (loop.aborted) return
    startTurn(loop, epilogue)
  })
}

/**
 * Block a final answer while a plan step the model called done has an unproven
 * check. This is the harness half of the verify contract: without it, "confirm
 * changes with an independent check" is advice the model can decline to take
 * and no one is any the wiser.
 *
 * One shot per PLAN (see `claimVerifyCheckpoint`). A model that ignores the
 * checkpoint twice is not going to be convinced by a third copy of the same
 * message, and a loop that cannot end is worse than an unverified answer the
 * user can read the transcript for.
 */
function pushBackOnUnverifiedPlan(loop: LoopState, tabId: string): boolean {
  const plan = useAIStore.getState().chatTabs.find((t) => t.id === tabId)?.plan
  if (!plan || plan.length === 0) return false
  const unmet = unmetPlanSteps(plan, taskEvidence(tabId))
  if (unmet.length === 0) return false
  if (!claimVerifyCheckpoint(tabId, plan)) return false

  loop.conversation.push({ role: 'user', content: unmetStepsPrompt(unmet) })
  debugLog({
    category: 'action.triggered',
    tabId,
    message: 'agent.verify.pushback',
    data: { steps: unmet.map((u) => ({ id: u.item.id, state: u.state.kind })) }
  })
  return true
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

// This module owns app-lifetime singletons: the streaming IPC listeners, and
// the maps of turns currently in flight. Those cannot be hot-swapped — a hot
// update gives the module fresh empty maps while the listeners registered by
// the PREVIOUS instance stay subscribed and keep reading the old ones, so every
// reply after that point is delivered to a map nobody writes to and its chat is
// left waiting forever. A full reload is the only coherent answer.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate())
}

/**
 * Release chats that are marked busy but can no longer be reached by any event.
 *
 * A stream event whose requestId we do not recognize means some turn lost its
 * link to the chat that started it. The global `busy` flag used to make that
 * self-healing by accident: one `setBusy(false)` freed the whole app. A per-tab
 * map has no such blunt instrument, so an orphaned entry would wedge that chat's
 * composer for the rest of the session — the failure this exists to prevent.
 *
 * "Unreachable" is narrow on purpose, because a chat can legitimately be busy
 * with nothing in `pending`: a turn parked on a summarization, or one whose tool
 * calls are waiting for the user to approve them. Both are revivable and must
 * survive; only a tab whose requestId is dead AND has neither is swept.
 */
function releaseUnreachableBusy(): void {
  const ai = useAIStore.getState()
  const revivable = new Set<string>(parked.keys())
  for (const loop of loops.values()) revivable.add(loop.tabId)
  for (const tabId of unreachableBusyTabs(ai.busyByTab, new Set(pending.keys()), revivable)) {
    debugLog({
      category: 'action.triggered',
      tabId,
      message: 'agent.busy.released',
      data: { requestId: ai.busyByTab[tabId] }
    })
    ai.clearTabBusy(tabId)
  }
}

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

/** Push settings that the loop reads synchronously (autonomy, command timeout). */
export function applyRuntimeAISettings(settings: AISettings): void {
  refreshAutonomyMode(settings.copilotAutonomy)
  refreshCommandTimeoutMinutes(settings.commandTimeoutMinutes)
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
    sessionAllowlist: sessionAllowlists.get(chatTabId),
    agentMode: useAIStore.getState().chatTabs.find((t) => t.id === chatTabId)?.agentMode ?? 'agent'
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
  const summarizeOnly = !!loop.summarizeOnly
  const toolsOff = chartTurn || summarizeOnly
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
  const chat = ai.chatTabs.find((t) => t.id === loop.tabId)
  const agentMode = chat?.agentMode ?? 'agent'
  const planMode = agentMode === 'plan'
  const executeMode = agentMode === 'execute'
  const toolSurface = {
    hasSkills: hasEnabledSkills(),
    aiSettingsIntent: loop.aiSettingsIntent,
    planMode,
    executeMode
  }
  const promptSections: PromptSections = {
    chart: chartTurn,
    mermaid: !!loop.mermaidIntent && !summarizeOnly,
    toolNames: toolsOff ? [] : toolNamesFor(loop.toolTier ?? 'full', toolSurface)
  }
  const skillsCatalog = buildSkillsContextMessage()
  // Prefix layer: near-constant across the task, so it stays at the front where
  // provider prefix caches can reuse it. The host's AGENTS.md belongs here for
  // the same reason — it is a property of the machine, not of the turn, and it
  // is warmed before the loop starts so this stays synchronous.
  const hostMemory = buildHostMemoryMessage(loop.contextTabId)
  const prefix: ChatMessageDTO[] = []
  if (skillsCatalog) prefix.push({ role: 'system', content: skillsCatalog })
  if (hostMemory) prefix.push({ role: 'system', content: hostMemory })

  // Suffix layer: everything that changes every turn (live app snapshot, the
  // task plan, the ledger of completed actions). Keeping it AFTER the
  // conversation both preserves the cacheable prefix and gives these facts
  // recency over the long system prompt.
  const suffix = buildTurnStateMessage([
    buildToolContextMessage(loop.toolTier, chat?.pinnedTabId),
    buildTaskMemoryMessage(loop.tabId),
    buildPlanContextMessage(loop.tabId),
    loop.fileContext
  ])

  // Bound the running conversation with what is actually left over, which is
  // why the surrounding layers are assembled first.
  const limit = loop.contextLimit ?? 0
  const { budget: available, fixed } = conversationBudget(
    loop,
    limit,
    toolsOff ? undefined : loop.toolTier ?? 'full',
    promptSections,
    toolSurface,
    [...prefix, ...suffix]
  )
  const budget = squeezeBudget(available, loop.budgetSqueeze)
  if (budget > 0) {
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
          budget,
          limit
        }
      })
    }
  }
  // What we believe we are about to send. The provider's own prompt_tokens is
  // compared against it in onDone: a count well below this means the endpoint
  // truncated the prompt rather than refusing it.
  loop.promptEstimate = fixed + conversationTokens(loop.conversation)

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
  ai.setTabBusy(loop.tabId, requestId)
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
    enableTools: !toolsOff,
    userRules,
    promptSections,
    aiSettingsIntent: loop.aiSettingsIntent,
    planMode,
    executeMode
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
): Promise<{ aborted?: boolean }> {
  const ai = useAIStore.getState()
  const call = findMessage(tabId, messageId)?.toolCalls?.find((c) => c.id === callId)
  if (!call) return {}
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
    return {}
  }

  ai.updateToolCall(tabId, messageId, callId, { status: 'running' })
  debugLog({
    category: 'action.triggered',
    tabId,
    message: `tool.${call.name}`,
    data: { args: parsed.args }
  })
  let unregisterAbort: (() => void) | undefined
  let aborted = false
  const chat = ai.chatTabs.find((t) => t.id === tabId)
  try {
    const invoke = (): Promise<ToolResult> =>
      executeToolCall(call.name, parsed.args, {
        chatTabId: tabId,
        pinnedTabId: chat?.pinnedTabId,
        execEvidence: taskEvidence(tabId),
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
    // A user interrupt is not transient: never re-run the command they stopped.
    if (res.retryable && !res.aborted) {
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
      data: { ok: res.ok, result: res.ok ? res.result : res.error, aborted: !!res.aborted }
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
    aborted = !!res.aborted
    if (aborted && chatAgentMode(tabId) === 'execute') {
      const loop = loops.get(messageId)
      if (loop) loop.interruptedByUser = true
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
  return { aborted }
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
  for (let i = 0; i < mutating.length; i++) {
    const out = await runToolCall(tabId, messageId, mutating[i], { deferContinue: true })
    if (!out.aborted) continue
    const cancelled = tNotice('copilot.interruptedCancel')
    for (const restId of mutating.slice(i + 1)) {
      useAIStore.getState().updateToolCall(tabId, messageId, restId, {
        status: 'rejected',
        result: cancelled,
        digest: cancelled
      })
    }
    break
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
  ai.setQueuedCount(tabId, 0)

  for (const [requestId, entry] of pending) {
    if (entry.tabId !== tabId) continue
    window.api.ai.cancel(requestId)
    entry.loop.aborted = true
    pending.delete(requestId)
    loops.delete(entry.messageId)
  }

  // A loop waiting on a summarization or a retry backoff is in neither map, so
  // it needs telling separately or it resumes once that wait ends.
  const waiting = parked.get(tabId)
  if (waiting) {
    waiting.aborted = true
    parked.delete(tabId)
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
  ai.clearTabBusy(tabId)
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
export function cancelPendingApprovals(tabId: string): number {
  const refs = getPendingToolCalls(tabId)
  if (refs.length === 0) return 0
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
  // The paused turn's request already completed; clear this chat's busy flag so
  // the new prompt can start a fresh turn.
  ai.clearTabBusy(tabId)
  return refs.length
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
  ai.clearTabBusy(tabId)
}

/** Provider errors are paragraphs; a notice has room for the first line. */
const NOTICE_ERROR_CHARS = 90

function shortError(error: string): string {
  const oneLine = error.replace(/\s+/g, ' ').trim()
  return oneLine.length > NOTICE_ERROR_CHARS
    ? `${oneLine.slice(0, NOTICE_ERROR_CHARS)}…`
    : oneLine
}

/**
 * Re-run the turn that just failed, optionally after a backoff.
 *
 * The failed turn's partial text is not an answer, so its message goes away and
 * the retry streams a fresh one. During a backoff the loop is `parked`: that is
 * what keeps Stop able to cancel the wait, and keeps the busy sweeper from
 * deciding the chat is unreachable while deliberately nothing is in flight.
 */
function retryTurn(entry: PendingRequest, waitMs: number): void {
  const { tabId, messageId, loop, epilogue } = entry
  if (!epilogue) useAIStore.getState().removeMessage(tabId, messageId)
  loops.delete(messageId)
  advance(loop, 'recovered', tabId)
  if (waitMs <= 0) {
    startTurn(loop, epilogue)
    return
  }
  parked.set(tabId, loop)
  void delay(waitMs).then(() => {
    if (parked.get(tabId) === loop) parked.delete(tabId)
    if (loop.aborted) return
    startTurn(loop, epilogue)
  })
}

/**
 * Answer a failed LLM turn instead of ending the task on it. Returns true when
 * a retry has been scheduled.
 *
 * `recovering` was a phase with no exit. The state machine defined `recovered`
 * and `unrecoverable` and the tests covered both, but nothing ever emitted
 * either: `onError` set the phase and then cleared busy, so a single hiccup
 * from the endpoint abandoned a task mid-plan and the user had to type
 * "continue" to restart a loop that already knew exactly what it was doing.
 *
 * Every retry is bounded per failure class and every one is announced. A silent
 * reconnect loop would be worse than the abandonment it replaces.
 */
function recoverFromTurnFailure(entry: PendingRequest, error: string): boolean {
  const { loop, tabId } = entry
  if (loop.aborted) return false
  const ai = useAIStore.getState()
  const plan = planRecovery(loop, error)

  if (plan.kind === 'compact') {
    loop.contextRecoveries = plan.attempt
    ai.setNotice(tNotice('copilot.context.retry'))
    debugLog({
      category: 'action.triggered',
      tabId,
      message: 'agent.recover.context',
      data: { error: shortError(error), promptEstimate: loop.promptEstimate }
    })
    retryTurn(entry, plan.waitMs)
    return true
  }

  if (plan.kind === 'backoff') {
    loop.transientRetries = plan.attempt
    ai.setNotice(
      tNotice('copilot.retry', {
        error: shortError(error),
        attempt: plan.attempt,
        max: plan.max
      })
    )
    debugLog({
      category: 'action.triggered',
      tabId,
      message: 'agent.recover.transient',
      data: { error: shortError(error), attempt: plan.attempt, waitMs: plan.waitMs }
    })
    retryTurn(entry, plan.waitMs)
    return true
  }

  debugLog({
    category: 'action.triggered',
    tabId,
    message: 'agent.recover.declined',
    data: { error: shortError(error), reason: plan.reason }
  })
  return false
}

/**
 * Re-run a turn the provider CUT at the output limit.
 *
 * A `length` finish is not a short answer, it is half of one: the prose stops
 * mid-sentence and a tool call stops mid-arguments. Acting on that half is
 * worse than paying for the turn again, and the fix is not a smaller window (it
 * was the right size) but a different split between prompt and answer — so the
 * conversation budget is squeezed for the rest of the task.
 */
function retryTruncatedTurn(entry: PendingRequest): boolean {
  const { loop, tabId } = entry
  if (loop.aborted) return false
  const plan = planTruncationRecovery(loop, loop.budgetSqueeze)
  if (!plan.retry) return false
  loop.truncationRetries = plan.attempt
  loop.budgetSqueeze = plan.squeeze
  useAIStore.getState().setNotice(tNotice('copilot.truncatedReply'))
  debugLog({
    category: 'action.triggered',
    tabId,
    message: 'agent.recover.truncated',
    data: { squeeze: loop.budgetSqueeze, budget: loop.conversationBudget }
  })
  advance(loop, 'recover', tabId)
  retryTurn(entry, 0)
  return true
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

const INTERRUPT_SUMMARY_PROMPT =
  'The user pressed Ctrl+C in the visible terminal and interrupted the running command. Do NOT call any tools. Write a short status update in the user\'s language: what was in progress, what the partial output indicates (success, failure, or unknown), and what remains unfinished. They already saw the terminal — do not paste or reformat its output.'

/** When every tool call of a turn is resolved, feed results back and continue. */
function maybeContinueLoop(tabId: string, messageId: string): void {
  const loop = loops.get(messageId)
  if (!loop) return
  if (loop.interruptedByUser) {
    const cancelled = tNotice('copilot.interruptedCancel')
    const open = findMessage(tabId, messageId)?.toolCalls ?? []
    for (const c of open) {
      if (c.status !== 'pending' && c.status !== 'running') continue
      useAIStore.getState().updateToolCall(tabId, messageId, c.id, {
        status: 'rejected',
        result: cancelled,
        digest: cancelled
      })
    }
  }
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
    recordExecEvidence(loop, c, raw)
  }

  // Tool results are now captured: observe -> verify.
  advance(loop, 'toolExecuted', tabId)
  advance(loop, 'observed', tabId)

  if (loop.interruptedByUser) {
    loop.summarizeOnly = true
    loop.conversation.push({ role: 'user', content: INTERRUPT_SUMMARY_PROMPT })
    debugLog({ category: 'user.action', tabId, message: 'agent.interrupt.summary', data: {} })
    startTurn(loop)
    return
  }

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
    useAIStore.getState().clearTabBusy(tabId)
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
  continueLoop(loop, displayOnly)
}

/**
 * Register the streaming IPC listeners exactly once for the app lifetime, so
 * chat responses are received regardless of whether the side panel is mounted.
 */
export function initAIService(): void {
  if (initialized) return
  initialized = true

  void window.api.config.getAISettings().then((s) => {
    applyRuntimeAISettings(normalizeAISettings(s))
  })

  // Replay whatever the user typed while THIS chat's task was still running.
  // Watching the busy map covers every way a loop can end (final answer, guard
  // trip, error, abort) without threading a callback through all of them, and
  // per-tab means a chat that just went idle replays its own queue rather than
  // waiting for every other chat to finish too.
  useAIStore.subscribe((state, prev) => {
    if (state.busyByTab === prev.busyByTab) return
    for (const tabId of Object.keys(prev.busyByTab)) {
      if (tabId in state.busyByTab) continue
      const queue = queuedPrompts.get(tabId)
      if (!queue || queue.length === 0) {
        queuedPrompts.delete(tabId)
        continue
      }
      const next = queue.shift() as string
      if (queue.length === 0) queuedPrompts.delete(tabId)
      syncQueueCount(tabId)
      void sendPrompt(next, tabId)
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
  window.api.ai.onDone(({ requestId, content, toolCalls, usage, finishReason }) => {
    const entry = pending.get(requestId)
    pending.delete(requestId)
    // No entry means this turn's answer has nowhere to go: it was superseded,
    // or (in dev) the module holding `pending` was hot-replaced out from under
    // the listener. The reply is lost either way, but the chat that asked for it
    // must not be left busy forever.
    if (!entry) {
      releaseUnreachableBusy()
      return
    }
    const { tabId, messageId, loop, epilogue } = entry
    const ai = useAIStore.getState()

    // Swap this turn's estimate for the provider's real count before the guard
    // checks the task budget below.
    if (usage && loop.guard) reconcileTokens(loop.guard, usage.total)

    // The provider CUT this reply at the output limit rather than the model
    // finishing it: the prose stops mid-sentence and a tool call stops
    // mid-arguments, so it is half a decision, not a short one. Retry with a
    // tighter budget; once that is spent, say the reply was cut instead of
    // presenting the fragment as a considered answer.
    if (finishReason === 'length' && !loop.summarizeOnly) {
      if (retryTruncatedTurn(entry)) return
      // Alongside the message, not inside it: the fragment itself is the
      // model's, this note is ours, and only the fragment should be replayed.
      if (!epilogue) ai.setMessageError(tabId, messageId, tNotice('copilot.truncatedReplyFinal'))
    }

    // Terminal Ctrl+C asked for a tools-off recap. Ignore any tool_calls the
    // model still emitted, and never nudge it to "act" on an empty reply.
    if (loop.summarizeOnly) {
      if (epilogue) {
        ai.clearTabBusy(tabId)
        return
      }
      advance(loop, 'finalAnswer', tabId)
      if (content.trim() === '') {
        ai.appendToMessage(tabId, messageId, tNotice('copilot.interruptedSummary'))
      }
      ai.finishMessage(tabId, messageId)
      ai.clearTabBusy(tabId)
      return
    }

    if (!toolCalls || toolCalls.length === 0) {
      // An epilogue turn with no tool call is just a redundant restatement of
      // the card(s) already shown — drop it entirely (nothing was rendered).
      if (epilogue) {
        ai.clearTabBusy(tabId)
        return
      }
      // The model is trying to finish. If it claimed a plan step done without
      // running the check it committed to, send it back once before letting
      // that claim reach the user.
      if (content.trim() !== '' && pushBackOnUnverifiedPlan(loop, tabId)) {
        ai.removeMessage(tabId, messageId)
        startTurn(loop)
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
      ai.clearTabBusy(tabId)
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
      const denied = isPlanMode(tabId)
        ? tNotice('copilot.plan.denied')
        : chatAgentMode(tabId) === 'execute'
          ? tNotice('copilot.execute.denied')
          : 'Blocked by the current autonomy policy: this command is destructive.'
      ai.updateToolCall(tabId, messageId, tc.id, {
        status: 'rejected',
        result: denied,
        digest: denied
      })
    })
    const autoIds = toolCalls.filter((_, i) => decisions[i] === 'auto').map((tc) => tc.id)
    if (autoIds.length > 0) void runAutoToolCalls(tabId, messageId, autoIds)
    else maybeContinueLoop(tabId, messageId)
  })
  window.api.ai.onError(({ requestId, error }) => {
    const entry = pending.get(requestId)
    pending.delete(requestId)
    if (!entry) {
      releaseUnreachableBusy()
      return
    }
    const ai = useAIStore.getState()
    advance(entry.loop, 'recover', entry.tabId)
    // Bounded, visible recovery: an over-window rejection is answered by
    // compacting, a transient failure by waiting. Only what neither can fix
    // reaches the user as an abandoned task.
    if (recoverFromTurnFailure(entry, error)) return
    advance(entry.loop, 'unrecoverable', entry.tabId)
    // The failure rides alongside the message rather than inside its text: it is
    // the app's diagnostic, and putting it in `content` made the next turn
    // replay it as something the assistant had said.
    if (entry.epilogue) {
      // No visible message exists for an epilogue turn yet — create one so the
      // error is surfaced to the user instead of being silently swallowed.
      ai.addMessage(entry.tabId, { id: entry.messageId, role: 'assistant', content: '', error })
    } else {
      ai.setMessageError(entry.tabId, entry.messageId, error)
      ai.finishMessage(entry.tabId, entry.messageId)
    }
    loops.delete(entry.messageId)
    ai.clearTabBusy(entry.tabId)
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

const FILE_MENTION_LINE_LIMIT = 200
const MAX_FILE_MENTIONS = 4

async function loadFileMentionContext(
  terminalTabId: string,
  paths: string[],
  username?: string
): Promise<string | undefined> {
  const unique = [...new Set(paths)].slice(0, MAX_FILE_MENTIONS)
  const parts: string[] = []
  for (const raw of unique) {
    const path = expandMentionPath(raw, username)
    const result = await readFile({
      tab_id: terminalTabId,
      path,
      limit: FILE_MENTION_LINE_LIMIT,
      offset: 1
    })
    if (!result.ok) {
      useAIStore.getState().setNotice(
        tNotice('copilot.path.readFail', { path: raw, error: result.error ?? 'read failed' })
      )
      continue
    }
    if (result.result) parts.push(result.result)
  }
  if (parts.length === 0) return undefined
  return `User-mentioned files (from @path; treat as the current contents on the pinned host):\n\n${parts.join('\n\n')}`
}

/**
 * LLM-summarize older messages when they no longer fit the window.
 * Returns the number compressed, 0 if nothing needed compressing, or null on failure.
 */
async function compactTabHistory(
  tabId: string,
  prompt: string,
  context: TerminalContext | undefined,
  opts?: { leaveBusy?: boolean }
): Promise<number | null> {
  const ai = useAIStore.getState()
  const tab = ai.chatTabs.find((t) => t.id === tabId)
  if (!tab) return 0

  const settings = normalizeAISettings(await window.api.config.getAISettings())
  const limit = resolveActiveContextLength(settings)
  const userRules = useUserRulesStore.getState().rules
  const tier = toolTierForProfile(settings.copilotModelProfile)
  const mentionsTerminal = hasTerminalMention(prompt, useSessionsStore.getState().sessions)
  const chartIntent = mentionsTerminal && !!context && CHART_INTENT.test(prompt)
  const surface = toolSurfaceFor(prompt, chatAgentMode(tabId))
  const budgetParams = {
    systemPrompt: buildEffectiveSystemPrompt(userRules, {
      chart: chartIntent,
      mermaid: MERMAID_INTENT.test(prompt),
      toolNames: chartIntent ? [] : toolNamesFor(tier, surface)
    }),
    contextMessage: fixedOverheadText(context, tabId, chartIntent ? undefined : tier, surface),
    draft: prompt,
    limit
  }
  const existingDto: BudgetMessage[] = tab.messages.map((m) => ({
    role: m.role,
    content: messageBudgetText(m)
  }))
  const { toCompress } = selectMessagesToCompress(existingDto, budgetParams)
  if (toCompress.length === 0) return 0

  // Compression has no LLM request id of its own, but the chat must still read
  // as busy so the UI blocks a second send while history is being rewritten.
  ai.setTabBusy(tabId, null)
  ai.setNotice(tNotice('copilot.context.compressing'))
  const result = await window.api.ai.compressHistory({
    messages: toCompress as ChatMessageDTO[],
    context
  })
  if (result.error || !result.summary) {
    ai.clearTabBusy(tabId)
    ai.setNotice(tNotice('copilot.context.compressFailed'))
    return null
  }
  const kept = tab.messages.slice(toCompress.length)
  ai.replaceMessages(tabId, [
    {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content: result.summary,
      isContextSummary: true
    },
    ...kept
  ])
  if (!opts?.leaveBusy) ai.clearTabBusy(tabId)
  return toCompress.length
}

/** `/compact`: run the same history compression sendPrompt uses, without a new turn. */
export async function compactActiveChat(): Promise<void> {
  const ai = useAIStore.getState()
  const tabId = ai.activeChatTabId
  if (!tabId) return
  if (isChatBusy(ai.busyByTab, tabId)) {
    ai.setNotice(tNotice('copilot.context.compressingBusy'))
    return
  }
  const tab = ai.chatTabs.find((t) => t.id === tabId)
  if (!tab || tab.messages.length === 0) {
    ai.setNotice(tNotice('copilot.context.nothingToCompact'))
    return
  }
  const terminals = useSessionsStore.getState()
  const pin = resolvePinnedTab(
    tab.pinnedTabId,
    tab.pinnedLabel,
    terminals.sessions.map((t) => t.id)
  )
  const contextTabId = terminalContextTabId(pin, terminals.activeSessionId)
  const context = contextTabId
    ? readTabContext(contextTabId, COPILOT_CONTEXT_MAX_LINES)
    : undefined
  const count = await compactTabHistory(tabId, '', context)
  if (count === null) return
  if (count === 0) {
    ai.setNotice(tNotice('copilot.context.alreadyCompact'))
    return
  }
  ai.setNotice(tNotice('copilot.context.compressed', { count }))
}

/**
 * Send a user prompt to the AI, attaching the pinned terminal's recent output
 * and host info as context. Mid-task prompts are queued and replayed when the
 * loop finishes.
 */
export async function sendPrompt(text: string, targetTabId?: string): Promise<void> {
  const prompt = text.trim()
  if (!prompt) return

  const tabId = targetTabId ?? useAIStore.getState().activeChatTabId
  if (!tabId) return

  // A new instruction while tool actions await approval supersedes them: drop
  // the paused loop and clear busy so this prompt can start a fresh turn.
  if (hasPendingToolCalls(tabId)) {
    const cancelled = cancelPendingApprovals(tabId)
    if (cancelled > 0) {
      useAIStore.getState().setNotice(tNotice('copilot.superseded', { count: cancelled }))
    }
  }

  const ai = useAIStore.getState()

  // A prompt sent mid-task is queued and replayed when the loop finishes.
  // Dropping it (the old behaviour) looked identical to a broken Send button.
  if (isChatBusy(ai.busyByTab, tabId)) {
    const queue = queuedPrompts.get(tabId) ?? []
    queue.push(prompt)
    queuedPrompts.set(tabId, queue)
    syncQueueCount(tabId)
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

  const paths = extractFileMentionPaths(prompt)
  const fileContext =
    paths.length > 0 && contextTabId
      ? await loadFileMentionContext(contextTabId, paths, contextTab?.username)
      : undefined

  // Warm the host's AGENTS.md before the budget is computed, so the memory is
  // both paid for and available on the very first turn rather than the second.
  await loadHostMemory(contextTabId)

  const settings = normalizeAISettings(await window.api.config.getAISettings())
  const limit = resolveActiveContextLength(settings)
  applyRuntimeAISettings(settings)
  const tier = toolTierForProfile(settings.copilotModelProfile)
  // Force the chart path only when a terminal is bound to read from.
  const chartIntent = mentionsTerminal && !!contextTab && CHART_INTENT.test(prompt)
  const boundTabId = pin.status === 'live' ? pin.tabId : contextTab?.id
  const boundSessionId = boundTabId
    ? terminals.sessions.find((t) => t.id === boundTabId)?.sessionId
    : undefined

  const compressed = await compactTabHistory(tabId, prompt, context, { leaveBusy: true })
  if (compressed === null) return
  if (compressed > 0) {
    useAIStore.getState().setNotice(tNotice('copilot.context.compressed', { count: compressed }))
  }

  tab = useAIStore.getState().chatTabs.find((t) => t.id === tabId)
  if (!tab) {
    useAIStore.getState().clearTabBusy(tabId)
    return
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
    chartIntent,
    fileContext
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
  const key = toolSurfaceKey(tier, surface)
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
  const pinnedTabId = chatTabId
    ? useAIStore.getState().chatTabs.find((t) => t.id === chatTabId)?.pinnedTabId
    : undefined
  return [
    buildContextMessage(context),
    buildToolContextMessage(tier, pinnedTabId),
    buildSkillsContextMessage(),
    buildHostMemoryMessage(pinnedTabId),
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
  const agentMode = activeChatTabId
    ? (useAIStore.getState().chatTabs.find((t) => t.id === activeChatTabId)?.agentMode ?? 'agent')
    : 'agent'
  const surface: ToolSurfaceOptions = {
    hasSkills: hasEnabledSkills(),
    aiSettingsIntent: true,
    planMode: agentMode === 'plan',
    executeMode: agentMode === 'execute'
  }

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
