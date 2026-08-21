import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useAIStore,
  clampPanelWidth,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  MAX_CHAT_TABS
} from '../../store/aiStore'
import { useTabsStore } from '../../store/tabsStore'
import {
  sendPrompt,
  computeActiveTabBudget,
  tryHandleToolApprovalFromInput,
  approveToolCall,
  rejectToolCall,
  abortLoop
} from '../../lib/aiService'
import { getPendingToolCalls } from '../../lib/toolApproval'
import { normalizeAISettings, DEFAULT_CONTEXT_LENGTHS } from '../../../shared/aiSettings'
import type { ModelProfile } from '../../../shared/types'
import { useT, type TranslationKey } from '../../lib/i18n'
import { SHORTCUT_COPY, SHORTCUT_CUT, SHORTCUT_PASTE } from '../../lib/shortcuts'
import ContextMenuItem from '../ContextMenuItem'
import { useLocaleStore } from '../../store/localeStore'
import { useUserRulesStore } from '../../store/userRulesStore'
import ChatMessage from './ChatMessage'
import ChatTabBar from './ChatTabBar'
import ChatHistoryPanel from './ChatHistoryPanel'
import ModelSelect from './ModelSelect'
import ContextMeter from './ContextMeter'
import PlanCard from './PlanCard'
import TerminalTabPicker from './TerminalTabPicker'
import { COPILOT_CONTEXT_MAX_LINES, COPILOT_TERMINAL_MENTION_MAX_LINES, readTerminalOutput } from '../../lib/terminalRegistry'
import {
  TERMINAL_MENTION,
  formatTerminalLabel,
  needsTerminalPicker,
  replaceAtMention,
  resolvePinnedTab,
  terminalContextTabId
} from '../../lib/pinnedTerminal'

const EXAMPLE_KEYS = [
  'copilot.example1',
  'copilot.example2',
  'copilot.example3',
  'copilot.example4'
] as const satisfies readonly TranslationKey[]

type PickerReason = 'mention' | 'send' | 'rebind'

type ContextMenu =
  | { source: 'chat'; x: number; y: number; text: string }
  | { source: 'composer'; x: number; y: number; selectionStart: number; selectionEnd: number }

export default function SidePanel(): JSX.Element {
  const activeChatTabId = useAIStore((s) => s.activeChatTabId)
  const activeChat = useAIStore((s) => s.chatTabs.find((t) => t.id === s.activeChatTabId))
  const busy = useAIStore((s) => s.busy)
  const busyTabId = useAIStore((s) => s.busyTabId)
  const panelWidth = useAIStore((s) => s.panelWidth)
  const notice = useAIStore((s) => s.notice)
  const setPanelWidth = useAIStore((s) => s.setPanelWidth)
  const setPanelOpen = useAIStore((s) => s.setPanelOpen)
  const updateDraft = useAIStore((s) => s.updateDraft)
  const setNotice = useAIStore((s) => s.setNotice)
  const setPinnedTerminal = useAIStore((s) => s.setPinnedTerminal)
  const addChatTab = useAIStore((s) => s.addChatTab)
  const messages = activeChat?.messages ?? []
  const input = activeChat?.draft ?? ''

  const terminalTabs = useTabsStore((s) => s.tabs)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const activeTab = terminalTabs.find((t) => t.id === activeTabId)

  const [resizing, setResizing] = useState(false)
  const [picker, setPicker] = useState<PickerReason | null>(null)
  const [pickerIndex, setPickerIndex] = useState(0)
  const pendingSendRef = useRef<string | null>(null)
  const pickerIndexRef = useRef(0)
  const terminalTabsRef = useRef(terminalTabs)
  const pickTerminalRef = useRef<(tabId: string) => void>(() => {})
  pickerIndexRef.current = pickerIndex
  terminalTabsRef.current = terminalTabs
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
  const userRules = useUserRulesStore((s) => s.rules)
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

  const pin = useMemo(
    () =>
      resolvePinnedTab(
        activeChat?.pinnedTabId,
        activeChat?.pinnedLabel,
        terminalTabs.map((t) => t.id)
      ),
    [activeChat?.pinnedTabId, activeChat?.pinnedLabel, terminalTabs]
  )
  const contextTabId = terminalContextTabId(pin, activeTabId)
  const contextTab = contextTabId ? terminalTabs.find((t) => t.id === contextTabId) : undefined

  const contextBudget = useMemo(() => {
    const limit = contextLengths[copilotProfile] ?? DEFAULT_CONTEXT_LENGTHS[copilotProfile]
    const mentionsTerminal = TERMINAL_MENTION.test(input)
    const context = contextTab
      ? {
          recentOutput: readTerminalOutput(
            contextTab.id,
            mentionsTerminal ? COPILOT_TERMINAL_MENTION_MAX_LINES : COPILOT_CONTEXT_MAX_LINES
          ),
          host: contextTab.host,
          username: contextTab.username
        }
      : undefined
    return computeActiveTabBudget({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      draft: input,
      context,
      limit,
      userRules,
      profile: copilotProfile
    })
  }, [messages, input, contextTab, copilotProfile, contextLengths, activeChatTabId, userRules])

  const pendingApprovals = useMemo(
    () => (activeChatTabId ? getPendingToolCalls(activeChatTabId) : []),
    // Recompute whenever the tab or its messages/tool-call statuses change.
    [activeChatTabId, messages]
  )
  const waitingToolApproval = pendingApprovals.length > 0

  const approveAllPending = (): void => {
    if (!activeChatTabId) return
    for (const ref of getPendingToolCalls(activeChatTabId)) {
      approveToolCall(activeChatTabId, ref.messageId, ref.callId)
    }
  }

  const rejectAllPending = (): void => {
    if (!activeChatTabId) return
    for (const ref of getPendingToolCalls(activeChatTabId)) {
      rejectToolCall(activeChatTabId, ref.messageId, ref.callId)
    }
  }

  useEffect(() => {
    setPicker(null)
    pendingSendRef.current = null
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
    if (!picker || picker === 'mention') return
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement
      if (el.closest('.mention-menu') || el.closest('.context-hint-btn')) return
      setPicker(null)
      pendingSendRef.current = null
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [picker])

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

  const defaultPickerIndex = (): number => {
    const idx = terminalTabs.findIndex((t) => t.id === (activeChat?.pinnedTabId ?? activeTabId))
    return idx >= 0 ? idx : 0
  }

  const openPicker = (reason: PickerReason): void => {
    setPickerIndex(defaultPickerIndex())
    setPicker(reason)
  }

  const closePicker = (): void => {
    setPicker(null)
    pendingSendRef.current = null
  }

  const sendText = (text: string): void => {
    if (!text.trim()) return

    if (activeChatTabId) {
      const approval = tryHandleToolApprovalFromInput(activeChatTabId, text)
      if (approval.handled) {
        if (approval.action === 'approve') {
          setNotice(t('tool.approvedViaChat', { count: approval.count }))
        } else if (approval.action === 'reject') {
          setNotice(t('tool.rejectedViaChat', { count: approval.count }))
        } else if (approval.action === 'dangerous_blocked') {
          setNotice(t('tool.approveDangerCard'))
        }
        updateDraft(activeChatTabId, '')
        closePicker()
        return
      }
      if (waitingToolApproval) {
        updateDraft(activeChatTabId, '')
        void sendPrompt(text)
        closePicker()
        return
      }
    }

    if (needsTerminalPicker(text, pin)) {
      pendingSendRef.current = text
      openPicker('send')
      setNotice(t('copilot.chooseTabToBind'))
      return
    }

    if (busy) return
    void sendPrompt(text)
    closePicker()
  }

  const send = (): void => {
    sendText(input)
  }

  const refreshMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const m = /@(\w*)$/.exec(before)
    const wantsMention = !!m && 'terminal'.startsWith(m[1].toLowerCase())
    if (wantsMention) {
      if (picker !== 'mention') openPicker('mention')
    } else if (picker === 'mention') {
      setPicker(null)
    }
  }

  const insertTerminalMention = (): void => {
    const el = inputRef.current
    const caret = el?.selectionStart ?? input.length
    const { next, caret: pos } = replaceAtMention(input, caret)
    setInput(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  const onPickTerminal = (tabId: string): void => {
    if (!activeChatTabId) return
    const reason = picker
    const label = formatTerminalLabel(
      terminalTabs.find((t) => t.id === tabId) ?? { username: '', host: tabId }
    )
    setPinnedTerminal(activeChatTabId, tabId)
    if (reason === 'mention') insertTerminalMention()
    const toSend = reason === 'send' ? pendingSendRef.current : null
    setPicker(null)
    pendingSendRef.current = null
    if (reason === 'send' && toSend) {
      void sendPrompt(toSend)
      return
    }
    if (reason === 'rebind') setNotice(t('copilot.rebindNotice', { host: label }))
  }
  pickTerminalRef.current = onPickTerminal

  useEffect(() => {
    if (!picker) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      const tabs = terminalTabsRef.current
      const count = tabs.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        if (count === 0) return
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setPickerIndex((i) => (i + delta + count) % count)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        const tab = tabs[pickerIndexRef.current]
        if (tab) pickTerminalRef.current(tab.id)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setPicker(null)
        pendingSendRef.current = null
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [picker])

  const clearPin = (): void => {
    if (!activeChatTabId) return
    setPinnedTerminal(activeChatTabId, null)
    closePicker()
    setNotice(t('copilot.pinCleared'))
  }

  const newChatForTerminal = (): void => {
    if (!activeTab) return
    const id = addChatTab()
    if (!id) {
      setNotice(t('copilot.maxTabsTitle', { max: MAX_CHAT_TABS }))
      return
    }
    setPinnedTerminal(id, activeTab.id)
    closePicker()
    setNotice(t('copilot.newChatForTerminalPinned', { host: formatTerminalLabel(activeTab) }))
  }

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value)
    refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
  }

  const stop = (): void => {
    if (activeChatTabId) abortLoop(activeChatTabId)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (picker) return
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

  const hintLabel =
    pin.status === 'live' && contextTab
      ? formatTerminalLabel(contextTab)
      : pin.status === 'stale'
        ? activeChat?.pinnedLabel || t('copilot.pinnedClosed')
        : activeTab
          ? formatTerminalLabel(activeTab)
          : t('copilot.noTerminal')
  const hintState =
    pin.status === 'live' ? 'live pinned' : pin.status === 'stale' ? 'idle stale' : activeTab ? 'live' : 'idle'
  const diverged =
    pin.status === 'live' && activeTab && activeTab.id !== pin.tabId
  const hintTitle = diverged
    ? t('copilot.viewingOther', { host: formatTerminalLabel(activeTab) })
    : pin.status === 'stale'
      ? t('copilot.pinnedClosed')
      : hintLabel
  const hintClass = [
    'context-hint',
    hintState,
    diverged ? 'diverged' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const pickerFooter =
    picker === 'rebind' ? (
      <div className="mention-footer">
        {pin.status !== 'none' && (
          <button
            type="button"
            className="mention-item mention-item--action"
            onMouseDown={(e) => e.preventDefault()}
            onClick={clearPin}
          >
            <span className="mention-name">{t('copilot.clearPin')}</span>
          </button>
        )}
        <button
          type="button"
          className="mention-item mention-item--action"
          disabled={!activeTab}
          onMouseDown={(e) => e.preventDefault()}
          onClick={newChatForTerminal}
        >
          <span className="mention-name">{t('copilot.newChatForTerminal')}</span>
        </button>
      </div>
    ) : null

  const contextHint = (placement: 'header' | 'composer'): JSX.Element => (
    <button
      type="button"
      className={`${hintClass} context-hint-btn context-hint--${placement}`}
      title={hintTitle}
      aria-label={t('copilot.pickTerminal')}
      onClick={() => (picker === 'rebind' ? closePicker() : openPicker('rebind'))}
    >
      {hintLabel}
      {pin.status === 'live' && <span className="context-hint-pin">{t('copilot.pinnedHint')}</span>}
    </button>
  )

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
          {contextHint('header')}
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
                  onClick={() => sendText(t(key))}
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

      <PlanCard />

      {pendingApprovals.length > 1 && (
        <div className="tool-approval-batch">
          <span className="tool-approval-batch-label">
            {t('tool.approveAllHint', { count: pendingApprovals.length })}
          </span>
          <div className="tool-approval-batch-actions">
            <button type="button" className="tool-btn-approve" onClick={approveAllPending}>
              {t('tool.approveAll')}
            </button>
            <button type="button" className="tool-btn-reject" onClick={rejectAllPending}>
              {t('tool.rejectAll')}
            </button>
          </div>
        </div>
      )}

      <div className="composer">
        {contextHint('composer')}
        <div className="composer-box">
          {picker && (
            <TerminalTabPicker
              tabs={terminalTabs}
              activeTabId={activeTabId}
              pinnedTabId={activeChat?.pinnedTabId}
              highlightIndex={pickerIndex}
              emptyLabel={t('copilot.noOpenTabs')}
              onHighlight={setPickerIndex}
              onSelect={onPickTerminal}
              footer={pickerFooter}
            />
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
            {busy && busyTabId === activeChatTabId ? (
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
