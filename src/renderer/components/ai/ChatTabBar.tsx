import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useAIStore,
  DEFAULT_CHAT_TAB_TITLE,
  MAX_CHAT_TABS,
  openChatTabs,
  type ChatTab
} from '../../store/aiStore'
import { useT } from '../../lib/i18n'

function tabLabel(tab: ChatTab, newChatLabel: string): string {
  return tab.title === DEFAULT_CHAT_TAB_TITLE ? newChatLabel : tab.title
}

interface Props {
  onOpenHistory: () => void
}

export default function ChatTabBar({ onOpenHistory }: Props): JSX.Element {
  const {
    chatTabs,
    activeChatTabId,
    busy,
    busyTabId,
    addChatTab,
    archiveChatTab,
    setActiveChatTab,
    clearActiveTab,
    activeRequestId,
    setBusy
  } = useAIStore()
  const t = useT()

  const openTabs = openChatTabs(chatTabs)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false })

  const newChatLabel = t('copilot.newChat')
  const atTabLimit = openTabs.length >= MAX_CHAT_TABS
  const activeTab = chatTabs.find((t) => t.id === activeChatTabId)
  const canClear = (activeTab?.messages.length ?? 0) > 0

  const updateScrollEdges = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    setScrollEdges({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    })
  }, [])

  useEffect(() => {
    updateScrollEdges()
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(updateScrollEdges)
    observer.observe(el)
    return () => observer.disconnect()
  }, [openTabs.length, updateScrollEdges])

  useEffect(() => {
    if (!activeChatTabId) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeChatTabId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    requestAnimationFrame(updateScrollEdges)
  }, [activeChatTabId, openTabs.length, updateScrollEdges])

  const scrollTabs = (direction: -1 | 1): void => {
    scrollRef.current?.scrollBy({ left: direction * 140, behavior: 'smooth' })
  }

  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const el = scrollRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    e.preventDefault()
    el.scrollLeft += e.deltaY
    updateScrollEdges()
  }

  const handleClose = (e: React.MouseEvent, tab: ChatTab): void => {
    e.stopPropagation()
    if (busy && busyTabId === tab.id && activeRequestId) {
      window.api.ai.cancel(activeRequestId)
      setBusy(false)
    }
    archiveChatTab(tab.id)
  }

  const trackClass = [
    'copilot-tabbar-track',
    scrollEdges.left ? 'can-scroll-left' : '',
    scrollEdges.right ? 'can-scroll-right' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="copilot-tabbar" role="tablist" aria-label={t('copilot.title')}>
      <div className={trackClass}>
        {scrollEdges.left && (
          <button
            type="button"
            className="copilot-tabbar-nav copilot-tabbar-nav--left"
            onClick={() => scrollTabs(-1)}
            aria-label={t('copilot.scrollTabsLeft')}
            title={t('copilot.scrollTabsLeft')}
          >
            <span className="copilot-tabbar-nav-glyph" aria-hidden />
          </button>
        )}
        <div
          ref={scrollRef}
          className="copilot-tabbar-scroll"
          onScroll={updateScrollEdges}
          onWheel={onWheel}
        >
          {openTabs.map((tab) => {
            const isActive = tab.id === activeChatTabId
            const isStreaming = busy && busyTabId === tab.id
            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                className={`copilot-tab ${isActive ? 'active' : ''} ${isStreaming ? 'streaming' : ''}`}
                onClick={() => setActiveChatTab(tab.id)}
                title={tabLabel(tab, newChatLabel)}
                role="tab"
                aria-selected={isActive}
              >
                {isStreaming && <span className="copilot-tab-pulse" aria-hidden />}
                <span className="copilot-tab-label">{tabLabel(tab, newChatLabel)}</span>
                <button
                  type="button"
                  className="copilot-tab-close"
                  aria-label={t('copilot.closeTab')}
                  onClick={(e) => handleClose(e, tab)}
                >
                  <span className="copilot-tab-close-glyph" aria-hidden>
                    ×
                  </span>
                </button>
              </div>
            )
          })}
        </div>
        {scrollEdges.right && (
          <button
            type="button"
            className="copilot-tabbar-nav copilot-tabbar-nav--right"
            onClick={() => scrollTabs(1)}
            aria-label={t('copilot.scrollTabsRight')}
            title={t('copilot.scrollTabsRight')}
          >
            <span className="copilot-tabbar-nav-glyph" aria-hidden />
          </button>
        )}
      </div>
      <div className="copilot-tabbar-actions">
        <button
          type="button"
          className="copilot-tab-action copilot-tab-add"
          onClick={() => addChatTab()}
          disabled={atTabLimit}
          title={atTabLimit ? t('copilot.maxTabsTitle', { max: MAX_CHAT_TABS }) : t('copilot.newTab')}
          aria-label={atTabLimit ? t('copilot.maxTabsTitle', { max: MAX_CHAT_TABS }) : t('copilot.newTab')}
        >
          <span className="copilot-tab-add-glyph" aria-hidden>
            +
          </span>
        </button>
        <button
          type="button"
          className="copilot-tab-action copilot-tab-history"
          onClick={onOpenHistory}
          title={t('copilot.history.openHistory')}
          aria-label={t('copilot.history.openHistory')}
        >
          <span className="copilot-tab-history-glyph" aria-hidden />
        </button>
        <button
          type="button"
          className="copilot-tab-action copilot-tab-clear"
          onClick={clearActiveTab}
          disabled={!canClear || busy}
          title={t('copilot.clearTitle')}
          aria-label={t('copilot.clearTitle')}
        >
          <span className="copilot-tab-clear-glyph" aria-hidden />
        </button>
      </div>
    </div>
  )
}
