import { useAIStore } from '../store/aiStore'
import { useTabsStore } from '../store/tabsStore'
import { readTerminalOutput } from './terminalRegistry'
import type { ChatMessageDTO, TerminalContext } from '../../shared/types'

/** Maps an in-flight requestId to the assistant message being streamed. */
const pending = new Map<string, string>()
let initialized = false

/**
 * Register the streaming IPC listeners exactly once for the app lifetime, so
 * chat responses are received regardless of whether the side panel is mounted.
 */
export function initAIService(): void {
  if (initialized) return
  initialized = true

  window.api.ai.onChunk(({ requestId, delta }) => {
    const msgId = pending.get(requestId)
    if (msgId) useAIStore.getState().appendToMessage(msgId, delta)
  })
  window.api.ai.onDone(({ requestId }) => {
    const msgId = pending.get(requestId)
    if (msgId) useAIStore.getState().finishMessage(msgId)
    pending.delete(requestId)
    useAIStore.getState().setBusy(false)
  })
  window.api.ai.onError(({ requestId, error }) => {
    const msgId = pending.get(requestId)
    if (msgId) {
      const ai = useAIStore.getState()
      ai.appendToMessage(msgId, `\n\n[Error] ${error}`)
      ai.finishMessage(msgId)
    }
    pending.delete(requestId)
    useAIStore.getState().setBusy(false)
  })
}

/**
 * Send a user prompt to the AI, attaching the active terminal's recent output
 * and host info as context. Ignored while another request is in flight.
 */
export function sendPrompt(text: string): void {
  const prompt = text.trim()
  const ai = useAIStore.getState()
  if (!prompt || ai.busy) return

  const history: ChatMessageDTO[] = ai.messages.map((m) => ({
    role: m.role,
    content: m.content
  }))
  history.push({ role: 'user', content: prompt })

  const userId = crypto.randomUUID()
  const assistantId = crypto.randomUUID()
  const requestId = crypto.randomUUID()

  ai.addMessage({ id: userId, role: 'user', content: prompt })
  ai.addMessage({ id: assistantId, role: 'assistant', content: '', streaming: true })
  pending.set(requestId, assistantId)
  ai.setBusy(true, requestId)

  const activeTab = useTabsStore.getState().tabs.find(
    (t) => t.id === useTabsStore.getState().activeTabId
  )
  const context: TerminalContext | undefined = activeTab
    ? {
        recentOutput: readTerminalOutput(activeTab.id, 40),
        host: activeTab.host,
        username: activeTab.username
      }
    : undefined

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
  sendPrompt(prompt)
}
