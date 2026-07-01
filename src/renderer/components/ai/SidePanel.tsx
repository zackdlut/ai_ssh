import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useAIStore,
  clampPanelWidth,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH
} from '../../store/aiStore'
import { useTabsStore } from '../../store/tabsStore'
import { sendPrompt, computeActiveTabBudget, tryHandleToolApprovalFromInput } from '../../lib/aiService'
import { hasPendingToolCalls } from '../../lib/toolApproval'
import { normalizeAISettings, DEFAULT_CONTEXT_LENGTHS } from '../../../shared/aiSettings'
import type { ModelProfile } from '../../../shared/types'
import { useT, type TranslationKey } from '../../lib/i18n'
import { SHORTCUT_COPY, SHORTCUT_CUT, SHORTCUT_PASTE } from '../../lib/shortcuts'
import ContextMenuItem from '../ContextMenuItem'
import { useLocaleStore } from '../../store/localeStore'
import ChatMessage from './ChatMessage'
import ChatTabBar from './ChatTabBar'
import ChatHistoryPanel from './ChatHistoryPanel'
import ModelSelect from './ModelSelect'
import ContextMeter from './ContextMeter'
import { COPILOT_CONTEXT_MAX_LINES, COPILOT_TERMINAL_MENTION_MAX_LINES, readTerminalOutput } from '../../lib/terminalRegistry'

const TERMINAL_MENTION = /@terminal\b/i

const EXAMPLE_KEYS = [
  'copilot.example1',
  'copilot.example2',
  'copilot.example3',
  'copilot.example4'
] as const satisfies readonly TranslationKey[]

type ContextMenu =
  | { source: 'chat'; x: number; y: number; text: string }
  | { source: 'composer'; x: number; y: number; selectionStart: number; selectionEnd: number }

export default function SidePanel(): JSX.Element {
  const activeChatTabId = useAIStore((s) => s.activeChatTabId)
  const activeChat = useAIStore((s) => s.chatTabs.find((t) => t.id === s.activeChatTabId))
  const busy = useAIStore((s) => s.busy)
  const activeRequestId = useAIStore((s) => s.activeRequestId)
  const panelWidth = useAIStore((s) => s.panelWidth)
  const notice = useAIStore((s) => s.notice)
  const setPanelWidth = useAIStore((s) => s.setPanelWidth)
  const setBusy = useAIStore((s) => s.setBusy)
  const setPanelOpen = useAIStore((s) => s.setPanelOpen)
  const updateDraft = useAIStore((s) => s.updateDraft)
  const setNotice = useAIStore((s) => s.setNotice)
  const messages = activeChat?.messages ?? []
  const input = activeChat?.draft ?? ''

  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

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
  const [contextLengths, setContextLengths] = useState<Record<ModelProfile, number>>({
    ...DEFAULT_CONTEXT_LENGTHS
  })
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const locale = useLocaleStore((s) => s.locale)
  const t = useT()

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice, setNotice])

  useEffect(() => {
    void window.api.config.getAISettings().then((s) => {
      const normalized = normalizeAISettings(s)
      setCopilotProfile(normalized.copilotModelProfile)
      setModelNames({ ...normalized.models })
      setContextLengths({ ...normalized.contextLengths })
    })
  }, [])

  const contextBudget = useMemo(() => {
    const limit = contextLengths[copilotProfile] ?? DEFAULT_CONTEXT_LENGTHS[copilotProfile]
    const mentionsTerminal = TERMINAL_MENTION.test(input)
    const context = activeTab
      ? {
          recentOutput: readTerminalOutput(
            activeTab.id,
            mentionsTerminal ? COPILOT_TERMINAL_MENTION_MAX_LINES : COPILOT_CONTEXT_MAX_LINES
          ),
          host: activeTab.host,
          username: activeTab.username
        }
      : undefined
    return computeActiveTabBudget({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      draft: input,
      context,
      limit
    })
  }, [messages, input, activeTab, copilotProfile, contextLengths, activeChatTabId])

  const waitingToolApproval = Boolean(
    activeChatTabId && hasPendingToolCalls(activeChatTabId)
  )

  useEffect(() => {
    setMentionOpen(false)
  }, [activeChatTabId])

  const onProfileChange = (profile: ModelProfile): void => {
    setCopilotProfile(profile)
    void window.api.config.getAISettings().then((s) => {
      const normalized = normalizeAISettings(s)
      void window.api.config.setAISettings({ ...normalized, copilotModelProfile: profile })
    })
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, activeChatTabId])

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

  const setInput = (value: string): void => {
    if (activeChatTabId) updateDraft(activeChatTabId, value)
  }

  const showChatCopyMenu = (e: React.MouseEvent, text: string): void => {
    const selection = text.trim()
    if (!selection) {
      setMenu(null)
      return
    }
    e.preventDefault()
    setMenu({ source: 'chat', x: e.clientX, y: e.clientY, text: selection })
  }

  const onChatContextMenu = (e: React.MouseEvent): void => {
    showChatCopyMenu(e, window.getSelection()?.toString() ?? '')
  }

  const onComposerContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>): void => {
    e.preventDefault()
    const el = e.currentTarget
    setMenu({
      source: 'composer',
      x: e.clientX,
      y: e.clientY,
      selectionStart: el.selectionStart ?? 0,
      selectionEnd: el.selectionEnd ?? 0
    })
  }

  const copySelection = (): void => {
    if (!menu) return
    if (menu.source === 'chat') {
      void navigator.clipboard.writeText(menu.text)
    } else {
      const text = input.slice(menu.selectionStart, menu.selectionEnd)
      if (text) void navigator.clipboard.writeText(text)
    }
    setMenu(null)
  }

  const cutSelection = (): void => {
    if (!menu || menu.source !== 'composer') return
    const { selectionStart: start, selectionEnd: end } = menu
    if (start === end) return
    const text = input.slice(start, end)
    void navigator.clipboard.writeText(text)
    const next = input.slice(0, start) + input.slice(end)
    setInput(next)
    requestAnimationFrame(() => {
      const el = inputRef.current
      el?.focus()
      el?.setSelectionRange(start, start)
      refreshMention(next, start)
    })
    setMenu(null)
  }

  const pasteToComposer = (): void => {
    if (!menu || menu.source !== 'composer') return
    const { selectionStart: start, selectionEnd: end } = menu
    void navigator.clipboard.readText().then((clip) => {
      if (!clip) return
      const before = input.slice(0, start)
      const after = input.slice(end)
      const next = before + clip + after
      const pos = start + clip.length
      setInput(next)
      requestAnimationFrame(() => {
        const el = inputRef.current
        el?.focus()
        el?.setSelectionRange(pos, pos)
        refreshMention(next, pos)
      })
    })
    setMenu(null)
  }

  const send = (): void => {
    const text = input.trim()
    if (!text) return

    if (activeChatTabId) {
      const approval = tryHandleToolApprovalFromInput(activeChatTabId, text)
      if (approval.handled) {
        if (approval.action === 'approve') {
          setNotice(t('tool.approvedViaChat', { count: approval.count }))
        } else if (approval.action === 'reject') {
          setNotice(t('tool.rejectedViaChat', { count: approval.count }))
        } else {
          setNotice(t('tool.approvalRequired'))
        }
        updateDraft(activeChatTabId, '')
        setMentionOpen(false)
        return
      }
    }

    if (busy) return
    void sendPrompt(text)
    setMentionOpen(false)
  }

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

  const onHandleKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') setPanelWidth(panelWidth + 24)
    else if (e.key === 'ArrowRight') setPanelWidth(panelWidth - 24)
  }

  const terminalLabel = activeTab ? `${activeTab.username}@${activeTab.host}` : t('copilot.noTerminal')
  const terminalState = activeTab ? 'live' : 'idle'

  return (
    <div className="side-panel copilot-panel" style={{ width: panelWidth }}>
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
          <span className="panel-title-text">{t('copilot.title')}</span>
          <span
            className={`context-hint context-hint--header ${terminalState}`}
            title={terminalLabel}
          >
            {terminalLabel}
          </span>
        </span>
        <div className="panel-toolbar">
          <button className="toolbar-btn panel-close" onClick={() => setPanelOpen(false)} title={t('copilot.hide')}>
            ✕
          </button>
        </div>
      </div>

      <ChatTabBar onOpenHistory={() => setHistoryOpen(true)} />

      <div
        className={`chat-list${waitingToolApproval ? ' chat-list--approval' : ''}`}
        ref={listRef}
        onContextMenu={onChatContextMenu}
      >
        {messages.length === 0 ? (
          <div className="chat-empty">
            {t('copilot.emptyLead')}
            <div className="hint-chip-group">
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
        <span
          className={`context-hint context-hint--composer ${terminalState}`}
          title={terminalLabel}
        >
          {terminalLabel}
        </span>
        <div className="composer-box">
          {mentionOpen && (
            <div className="mention-menu" role="listbox">
              <button
                className="mention-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={insertTerminalMention}
              >
                <span className="mention-name">@terminal</span>
                <span className="mention-desc">{t('copilot.mentionDesc')}</span>
              </button>
            </div>
          )}
          <textarea
            key={activeChatTabId ?? 'composer'}
            ref={inputRef}
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onContextMenu={onComposerContextMenu}
            placeholder={
              waitingToolApproval ? t('tool.approvalPlaceholder') : t('copilot.placeholder')
            }
          />
          <div className="composer-toolbar">
            <ContextMeter key={activeChatTabId ?? 'meter'} budget={contextBudget} />
            <ModelSelect
              value={copilotProfile}
              modelNames={modelNames}
              locale={locale}
              disabled={busy}
              onChange={onProfileChange}
            />
            {busy && activeRequestId ? (
              <button
                type="button"
                className="composer-send danger"
                onClick={stop}
                title={t('copilot.stop')}
                aria-label={t('copilot.stop')}
              >
                <span className="composer-send-icon composer-send-icon--stop" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                className="composer-send primary"
                onClick={send}
                disabled={!input.trim()}
                title={waitingToolApproval ? t('tool.approve') : t('copilot.send')}
                aria-label={waitingToolApproval ? t('tool.approve') : t('copilot.send')}
              >
                <span className="composer-send-icon" aria-hidden>
                  ↑
                </span>
              </button>
            )}
          </div>
        </div>
      </div>

      {historyOpen && <ChatHistoryPanel onClose={() => setHistoryOpen(false)} />}

      {notice && <div className="copilot-notice">{notice}</div>}

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.source === 'composer' ? (
            <>
              <ContextMenuItem
                shortcut={SHORTCUT_COPY}
                icon="copy"
                onClick={copySelection}
                disabled={menu.selectionStart === menu.selectionEnd}
              >
                {t('common.copy')}
              </ContextMenuItem>
              <ContextMenuItem
                shortcut={SHORTCUT_CUT}
                icon="cut"
                onClick={cutSelection}
                disabled={menu.selectionStart === menu.selectionEnd}
              >
                {t('common.cut')}
              </ContextMenuItem>
              <ContextMenuItem shortcut={SHORTCUT_PASTE} icon="paste" onClick={pasteToComposer}>
                {t('common.paste')}
              </ContextMenuItem>
            </>
          ) : (
            <ContextMenuItem shortcut={SHORTCUT_COPY} icon="copy" onClick={copySelection}>
              {t('common.copy')}
            </ContextMenuItem>
          )}
        </div>
      )}
    </div>
  )
}
