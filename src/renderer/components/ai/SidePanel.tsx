import { useEffect, useRef, useState } from 'react'
import {
  useAIStore,
  clampPanelWidth,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH
} from '../../store/aiStore'
import { useTabsStore } from '../../store/tabsStore'
import { sendPrompt } from '../../lib/aiService'
import ChatMessage from './ChatMessage'

export default function SidePanel(): JSX.Element {
  const { messages, busy, activeRequestId, panelWidth, setPanelWidth, setBusy, setPanelOpen, clear } =
    useAIStore()
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const [input, setInput] = useState('')
  const [resizing, setResizing] = useState(false)
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

  // Drag the left edge to resize. Dragging left widens the panel.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidth
    setResizing(true)

    const onMove = (ev: MouseEvent): void => {
      setPanelWidth(startWidth + (startX - ev.clientX))
    }
    const onUp = (): void => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // Keyboard a11y: arrow keys nudge the width when the handle is focused.
  const onHandleKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') setPanelWidth(panelWidth + 24)
    else if (e.key === 'ArrowRight') setPanelWidth(panelWidth - 24)
  }

  return (
    <div className="side-panel" style={{ width: panelWidth }}>
      <div
        className={`panel-resizer ${resizing ? 'active' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Copilot panel"
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={clampPanelWidth(panelWidth)}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={onHandleKey}
        onDoubleClick={() => setPanelWidth(392)}
        title="拖动调整宽度（双击重置）"
      />
      <div className="side-panel-header">
        <span className="panel-title">
          <span className="spark" />
          AI Copilot
        </span>
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
            用自然语言描述你的意图，例如：
            <div style={{ marginTop: 10 }}>
              <span className="hint-chip">查看占用 8080 端口的进程</span>
              <span className="hint-chip">show disk usage by directory</span>
              <span className="hint-chip">统计日志里的错误数</span>
            </div>
            <div style={{ marginTop: 16, color: 'var(--text-faint)' }}>
              建议的命令会渲染成卡片，可一键在当前终端运行。
            </div>
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
