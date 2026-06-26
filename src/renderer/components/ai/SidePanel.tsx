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
import { modelProfileLabel, useT, type TranslationKey } from '../../lib/i18n'
import { useLocaleStore } from '../../store/localeStore'
import ChatMessage from './ChatMessage'

const EXAMPLE_KEYS = [
  'copilot.example1',
  'copilot.example2',
  'copilot.example3',
  'copilot.example4'
] as const satisfies readonly TranslationKey[]

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
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const locale = useLocaleStore((s) => s.locale)
  const t = useT()

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

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('wheel', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const showCopyMenu = (e: React.MouseEvent, text: string): void => {
    const selection = text.trim()
    if (!selection) {
      setMenu(null)
      return
    }
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, text: selection })
  }

  const onChatContextMenu = (e: React.MouseEvent): void => {
    showCopyMenu(e, window.getSelection()?.toString() ?? '')
  }

  const onComposerContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    showCopyMenu(e, el.value.slice(start, end))
  }

  const copySelection = (): void => {
    if (menu) void navigator.clipboard.writeText(menu.text)
    setMenu(null)
  }

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
        aria-label={t('copilot.resizeLabel')}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={clampPanelWidth(panelWidth)}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={onHandleKey}
        onDoubleClick={() => setPanelWidth(392)}
        data-tip={t('copilot.resizeTip')}
      />
      <div className="side-panel-header">
        <span className="panel-title">
          <span className="spark" />
          {t('copilot.title')}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="toolbar-btn" onClick={clear} title={t('copilot.clearTitle')}>
            {t('copilot.clear')}
          </button>
          <button className="toolbar-btn" onClick={() => setPanelOpen(false)} title={t('copilot.hide')}>
            ✕
          </button>
        </div>
      </div>

      <div className="chat-list" ref={listRef} onContextMenu={onChatContextMenu}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            {t('copilot.emptyLead')}
            <div style={{ marginTop: 10 }}>
              {EXAMPLE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="hint-chip"
                  disabled={busy}
                  onClick={() => sendPrompt(t(key))}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 16, color: 'var(--text-faint)' }}>{t('copilot.emptyHint')}</div>
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
              <span className="mention-desc">{t('copilot.mentionDesc')}</span>
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          onContextMenu={onComposerContextMenu}
          placeholder={t('copilot.placeholder')}
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
                  {modelProfileLabel(locale, p.id)}
                </option>
              ))}
            </select>
            <span className="context-hint">
              {activeTab ? `${activeTab.username}@${activeTab.host}` : t('copilot.noTerminal')}
            </span>
          </div>
          {busy ? (
            <button className="danger" onClick={stop}>
              {t('copilot.stop')}
            </button>
          ) : (
            <button className="primary" onClick={send} disabled={!input.trim()}>
              {t('copilot.send')}
            </button>
          )}
        </div>
      </div>

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={copySelection}>{t('common.copy')}</button>
        </div>
      )}
    </div>
  )
}
