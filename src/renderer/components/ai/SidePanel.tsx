import { useEffect, useRef, useState } from 'react'
import { useAIStore } from '../../store/aiStore'
import { useTabsStore } from '../../store/tabsStore'
import { sendPrompt } from '../../lib/aiService'
import ChatMessage from './ChatMessage'

export default function SidePanel(): JSX.Element {
  const { messages, busy, activeRequestId, setBusy, setPanelOpen, clear } = useAIStore()
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const send = (): void => {
    const text = input.trim()
    if (!text || busy) return
    sendPrompt(text)
    setInput('')
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
