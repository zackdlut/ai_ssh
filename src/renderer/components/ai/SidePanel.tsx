import { useEffect, useRef, useState } from 'react'
import { useAIStore } from '../../store/aiStore'
import { useTabsStore } from '../../store/tabsStore'
import { readTerminalOutput } from '../../lib/terminalRegistry'
import ChatMessage from './ChatMessage'
import type { ChatMessageDTO, TerminalContext } from '../../../shared/types'

export default function SidePanel(): JSX.Element {
  const {
    messages,
    busy,
    activeRequestId,
    addMessage,
    appendToMessage,
    finishMessage,
    setBusy,
    setPanelOpen,
    clear
  } = useAIStore()
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // Maps an in-flight requestId to the assistant message being streamed.
  const pending = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    const offChunk = window.api.ai.onChunk(({ requestId, delta }) => {
      const msgId = pending.current.get(requestId)
      if (msgId) appendToMessage(msgId, delta)
    })
    const offDone = window.api.ai.onDone(({ requestId }) => {
      const msgId = pending.current.get(requestId)
      if (msgId) finishMessage(msgId)
      pending.current.delete(requestId)
      setBusy(false)
    })
    const offError = window.api.ai.onError(({ requestId, error }) => {
      const msgId = pending.current.get(requestId)
      if (msgId) {
        appendToMessage(msgId, `\n\n[Error] ${error}`)
        finishMessage(msgId)
      }
      pending.current.delete(requestId)
      setBusy(false)
    })
    return () => {
      offChunk()
      offDone()
      offError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const send = (): void => {
    const text = input.trim()
    if (!text || busy) return

    const history: ChatMessageDTO[] = messages.map((m) => ({
      role: m.role,
      content: m.content
    }))
    history.push({ role: 'user', content: text })

    const userId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const requestId = crypto.randomUUID()

    addMessage({ id: userId, role: 'user', content: text })
    addMessage({ id: assistantId, role: 'assistant', content: '', streaming: true })
    pending.current.set(requestId, assistantId)
    setBusy(true, requestId)
    setInput('')

    const context: TerminalContext | undefined = activeTab
      ? {
          recentOutput: readTerminalOutput(activeTab.id, 40),
          host: activeTab.host,
          username: activeTab.username
        }
      : undefined

    window.api.ai.chat({ requestId, messages: history, context })
  }

  const stop = (): void => {
    if (activeRequestId) window.api.ai.cancel(activeRequestId)
    setBusy(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span>AI Copilot</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="toolbar-btn" onClick={clear} title="Clear conversation">
            Clear
          </button>
          <button className="toolbar-btn" onClick={() => setPanelOpen(false)} title="Hide panel">
            ✕
          </button>
        </div>
      </div>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            Ask in natural language, e.g.
            <br />
            &ldquo;查看占用 8080 端口的进程&rdquo;
            <br />
            &ldquo;show disk usage by directory&rdquo;
            <br />
            <br />
            Suggested commands appear as cards you can run on the active terminal.
          </div>
        ) : (
          messages.map((m) => <ChatMessage key={m.id} message={m} />)
        )}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe what you want to do…"
        />
        <div className="composer-actions">
          <span className="context-hint">
            {activeTab ? `Context: ${activeTab.username}@${activeTab.host}` : 'No active terminal'}
          </span>
          {busy ? (
            <button className="danger" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={send} disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
