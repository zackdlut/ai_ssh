import { useAIStore, DEFAULT_CHAT_TAB_TITLE } from '../store/aiStore'
import { useTabsStore } from '../store/tabsStore'
import { COPILOT_CONTEXT_MAX_LINES, COPILOT_TERMINAL_MENTION_MAX_LINES, readTerminalOutput } from './terminalRegistry'
import { normalizeAISettings, resolveActiveContextLength } from '../../shared/aiSettings'
import { buildEffectiveSystemPrompt } from '../../shared/userRules'
import { selectMessagesToCompress, buildChatPayload, type BudgetMessage } from '../../shared/contextBudget'
import { buildContextMessage } from '../../shared/terminalContext'
import { translate } from './i18n/translations'
import { useLocaleStore } from '../store/localeStore'
import { debugLog } from './debugLog'
import { isDisplayTool, isReadonlyTool, requiresToolApproval } from '../../shared/aiTools'
import {
  buildSkillsContextMessage,
  buildToolContextMessage,
  executeToolCall,
  parseToolArgs
} from './aiTools'
import {
  getPendingToolCalls,
  hasPendingToolCalls,
  parseToolApprovalInput
} from './toolApproval'
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
  const snapshot = buildToolContextMessage()
  const skillsCatalog = buildSkillsContextMessage()
  const prefix: ChatMessageDTO[] = []
  if (skillsCatalog) prefix.push({ role: 'system', content: skillsCatalog })
  if (snapshot) prefix.push({ role: 'system', content: snapshot })
  const messages: ChatMessageDTO[] = [...prefix, ...loop.conversation]

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
  window.api.ai.chat({ requestId, messages, context: loop.context, enableTools: true, userRules })
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
    const res = await executeToolCall(call.name, parseToolArgs(call.args))
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
  void runToolCall(tabId, messageId, callId)
}

/** Reject a pending (action) tool call from the UI. */
export function rejectToolCall(tabId: string, messageId: string, callId: string): void {
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
  | { handled: true; action: 'unrecognized' }

/**
 * When action tools are awaiting approval, interpret short chat replies like
 * "确认" / "approve" as approve/reject instead of sending a new LLM turn.
 */
export function tryHandleToolApprovalFromInput(
  tabId: string,
  text: string
): ToolApprovalHandleResult {
  if (!hasPendingToolCalls(tabId)) return { handled: false }

  const action = parseToolApprovalInput(text)
  if (action === 'approve') {
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
  return { handled: true, action: 'unrecognized' }
}

/** When every tool call of a turn is resolved, feed results back and continue. */
function maybeContinueLoop(tabId: string, messageId: string): void {
  const loop = loops.get(messageId)
  if (!loop) return
  const calls = findMessage(tabId, messageId)?.toolCalls
  if (!calls || calls.length === 0) return
  if (calls.some((c) => c.status === 'pending' || c.status === 'running')) return

  loops.delete(messageId)
  for (const c of calls) {
    const content =
      c.status === 'rejected'
        ? 'User rejected this action.'
        : c.error
          ? `Error: ${c.error}`
          : (c.result ?? 'Done.')
    loop.conversation.push({ role: 'tool', tool_call_id: c.id, content })
  }

  // If this turn ran ONLY display tools and they all succeeded, the rich cards
  // already answer the user. Run the follow-up as an invisible "epilogue" turn
  // so a text-only restatement of those cards is dropped instead of shown.
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
        ai.removeMessage(tabId, messageId)
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
    loop.conversation.push({ role: 'assistant', content, tool_calls: toolCalls })
    const views: ToolCallView[] = toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.arguments,
      status: requiresToolApproval(tc.name, tc.arguments) ? 'pending' : 'running'
    }))
    ai.setToolCalls(tabId, messageId, views)
    loops.set(messageId, loop)

    for (const tc of toolCalls) {
      if (!requiresToolApproval(tc.name, tc.arguments)) void runToolCall(tabId, messageId, tc.id)
    }
  })
  window.api.ai.onError(({ requestId, error }) => {
    const entry = pending.get(requestId)
    pending.delete(requestId)
    if (entry) {
      const ai = useAIStore.getState()
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
    username: activeTerminalTab.username
  }
}

/**
 * Send a user prompt to the AI, attaching the active terminal's recent output
 * and host info as context. Ignored while another request is in flight.
 */
export async function sendPrompt(text: string): Promise<void> {
  const prompt = text.trim()
  const ai = useAIStore.getState()
  if (!prompt || ai.busy) return

  const tabId = ai.activeChatTabId
  if (!tabId) return

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
    conversation: history
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

/** Build context budget for the active chat tab (for UI meter). */
export function computeActiveTabBudget(params: {
  messages: { role: 'user' | 'assistant'; content: string }[]
  draft: string
  context?: TerminalContext
  limit: number
  userRules?: string
}) {
  return buildChatPayload({
    systemPrompt: buildEffectiveSystemPrompt(params.userRules ?? ''),
    contextMessage: buildContextMessage(params.context),
    messages: params.messages,
    draft: params.draft,
    limit: params.limit
  })
}
