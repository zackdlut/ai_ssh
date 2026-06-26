import { useEffect, useRef, useState } from 'react'
import {
  useAIStore,
  clampPanelWidth,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH
} from '../../store/aiStore'
import { useTabsStore } from '../../store/tabsStore'
import { sendPrompt } from '../../lib/aiService'
import { MODEL_PROFILES, normalizeAISettings, resolveModel } from '../../../shared/aiSettings'
import type { ModelProfile } from '../../../shared/types'
import ChatMessage from './ChatMessage'

const EXAMPLE_PROMPTS = [
  '查看占用 8080 端口的进程',
  'show disk usage by directory',
  '统计日志里的错误数',
  '@terminal 把 CPU 使用率画成实时折线图'
] as const

export default function SidePanel(): JSX.Element {
  const { messages, busy, activeRequestId, panelWidth, setPanelWidth, setBusy, setPanelOpen, clear } =
    useAIStore()
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const [input, setInput] = useState('')
  const [resizing, setResizing] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [copilotProfile, setCopilotProfile] = useState<ModelProfile>('default')
  const [modelNames, setModelNames] = useState<Record<ModelProfile, string>>({
    default: '',
    fast: '',
    medium: '',
    high: '',
    custom: ''
  })
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void window.api.config.getAISettings().then((s) => {
      const normalized = normalizeAISettings(s)
      setCopilotProfile(normalized.copilotModelProfile)
      setModelNames({ ...normalized.models })
    })
  }, [])

  const activeModelName = resolveModel(
    { baseURL: '', apiKey: '', copilotModelProfile: copilotProfile, nlModelProfile: 'fast', models: modelNames },
    copilotProfile
  )

  const onProfileChange = (profile: ModelProfile): void => {
    setCopilotProfile(profile)
    void window.api.config.getAISettings().then((s) => {
      const normalized = normalizeAISettings(s)
      void window.api.config.setAISettings({ ...normalized, copilotModelProfile: profile })
    })
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const send = (): void => {
    const text = input.trim()
    if (!text || busy) return
    sendPrompt(text)
    setInput('')
    setMentionOpen(false)
  }

  // Show the @terminal suggestion while the token being typed before the caret
  // is a prefix of "terminal".
  const refreshMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const m = /@(\w*)$/.exec(before)
    setMentionOpen(!!m && 'terminal'.startsWith(m[1].toLowerCase()))
  }

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value)
    refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
  }

  const insertTerminalMention = (): void => {
    const el = inputRef.current
    const caret = el?.selectionStart ?? input.length
    const before = input.slice(0, caret).replace(/@(\w*)$/, '@terminal ')
    const after = input.slice(caret)
    const next = before + after
    setInput(next)
    setMentionOpen(false)
    requestAnimationFrame(() => {
      el?.focus()
      const pos = before.length
      el?.setSelectionRange(pos, pos)
    })
  }

  const stop = (): void => {
    if (activeRequestId) window.api.ai.cancel(activeRequestId)
    setBusy(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // While an IME (e.g. Chinese pinyin) is composing, Enter confirms the
    // candidate word — it must not submit the message. keyCode 229 is the
    // legacy signal browsers emit for keystrokes consumed by the IME.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (mentionOpen && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault()
      insertTerminalMention()
      return
    }
    if (e.key === 'Escape' && mentionOpen) {
      setMentionOpen(false)
      return
    }
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
        data-tip="拖动调整宽度（双击重置）"
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
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="hint-chip"
                  disabled={busy}
                  onClick={() => sendPrompt(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 16, color: 'var(--text-faint)' }}>
              建议的命令会渲染成卡片，可一键在当前终端运行。输入 @terminal 可把当前终端的实时输出绘成动态图表。
            </div>
          </div>
        ) : (
          messages.map((m) => <ChatMessage key={m.id} message={m} />)
        )}
      </div>

      <div className="composer">
        {mentionOpen && (
          <div className="mention-menu" role="listbox">
            <button className="mention-item" onMouseDown={(e) => e.preventDefault()} onClick={insertTerminalMention}>
              <span className="mention-name">@terminal</span>
              <span className="mention-desc">绑定当前终端的实时输出</span>
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          placeholder="Describe what you want to do…（输入 @terminal 绑定终端）"
        />
        <div className="composer-actions">
          <div className="composer-meta">
            <select
              className="model-select"
              value={copilotProfile}
              disabled={busy}
              title={activeModelName}
              onChange={(e) => onProfileChange(e.target.value as ModelProfile)}
            >
              {MODEL_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="context-hint">
              {activeTab ? `${activeTab.username}@${activeTab.host}` : 'No active terminal'}
            </span>
          </div>
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
