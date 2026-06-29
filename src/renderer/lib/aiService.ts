import { useAIStore, DEFAULT_CHAT_TAB_TITLE } from '../store/aiStore'
import { useTabsStore } from '../store/tabsStore'
import { COPILOT_CONTEXT_MAX_LINES, COPILOT_TERMINAL_MENTION_MAX_LINES, readTerminalOutput } from './terminalRegistry'
import { normalizeAISettings, resolveActiveContextLength } from '../../shared/aiSettings'
import { COPILOT_SYSTEM_PROMPT } from '../../shared/copilotPrompts'
import { selectMessagesToCompress, buildChatPayload, type BudgetMessage } from '../../shared/contextBudget'
import { buildContextMessage } from '../../shared/terminalContext'
import { translate } from './i18n/translations'
import { useLocaleStore } from '../store/localeStore'
import type { ChatMessageDTO, TerminalContext } from '../../shared/types'

interface PendingRequest {
  tabId: string
  messageId: string
}

/** Maps an in-flight requestId to the assistant message being streamed. */
const pending = new Map<string, PendingRequest>()
let initialized = false

/**
 * Register the streaming IPC listeners exactly once for the app lifetime, so
 * chat responses are received regardless of whether the side panel is mounted.
 */
export function initAIService(): void {
  if (initialized) return
  initialized = true

  window.api.ai.onChunk(({ requestId, delta }) => {
    const entry = pending.get(requestId)
    if (entry) useAIStore.getState().appendToMessage(entry.tabId, entry.messageId, delta)
  })
  window.api.ai.onReasoning(({ requestId, delta }) => {
    const entry = pending.get(requestId)
    if (entry) useAIStore.getState().appendReasoning(entry.tabId, entry.messageId, delta)
  })
  window.api.ai.onDone(({ requestId }) => {
    const entry = pending.get(requestId)
    if (entry) useAIStore.getState().finishMessage(entry.tabId, entry.messageId)
    pending.delete(requestId)
    useAIStore.getState().setBusy(false)
  })
  window.api.ai.onError(({ requestId, error }) => {
    const entry = pending.get(requestId)
    if (entry) {
      const ai = useAIStore.getState()
      ai.appendToMessage(entry.tabId, entry.messageId, `\n\n[Error] ${error}`)
      ai.finishMessage(entry.tabId, entry.messageId)
    }
    pending.delete(requestId)
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
  const budgetParams = {
    systemPrompt: COPILOT_SYSTEM_PROMPT,
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
  const assistantId = crypto.randomUUID()
  const requestId = crypto.randomUUID()

  if (tab.title === DEFAULT_CHAT_TAB_TITLE) {
    ai.renameTab(tabId, autoTitleFromPrompt(prompt))
  }

  ai.updateDraft(tabId, '')
  ai.addMessage(tabId, { id: userId, role: 'user', content: prompt })
  ai.addMessage(tabId, {
    id: assistantId,
    role: 'assistant',
    content: '',
    streaming: true,
    boundSessionId: mentionsTerminal ? activeTerminalTab?.sessionId : undefined,
    boundTabId: mentionsTerminal ? activeTerminalTab?.id : undefined
  })
  pending.set(requestId, { tabId, messageId: assistantId })
  ai.setBusy(true, requestId, tabId)

  window.api.ai.chat({ requestId, messages: history, context })
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

  const clipped = text.length > MAX_SELECTION ? text.slice(0, MAX_SELECTION) + '\n…(truncated)' : text
  const prompt = `请基于当前终端的上下文，解释下面这段我在终端中选中的内容：\n\`\`\`\n${clipped}\n\`\`\``
  void sendPrompt(prompt)
}

/** Build context budget for the active chat tab (for UI meter). */
export function computeActiveTabBudget(params: {
  messages: { role: 'user' | 'assistant'; content: string }[]
  draft: string
  context?: TerminalContext
  limit: number
}) {
  return buildChatPayload({
    systemPrompt: COPILOT_SYSTEM_PROMPT,
    contextMessage: buildContextMessage(params.context),
    messages: params.messages,
    draft: params.draft,
    limit: params.limit
  })
}
