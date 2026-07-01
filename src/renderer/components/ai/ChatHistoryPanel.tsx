import { useEffect, useMemo, useState } from 'react'
import {
  useAIStore,
  DEFAULT_CHAT_TAB_TITLE,
  MAX_CHAT_TABS,
  CHAT_HISTORY_7_DAYS_MS,
  CHAT_HISTORY_30_DAYS_MS,
  type ChatTab
} from '../../store/aiStore'
import { useT } from '../../lib/i18n'

interface Props {
  onClose: () => void
}

type BulkPurgeAction = 'all' | '7d' | '30d'

function tabLabel(tab: ChatTab, newChatLabel: string): string {
  return tab.title === DEFAULT_CHAT_TAB_TITLE ? newChatLabel : tab.title
}

function lastUserPreview(tab: ChatTab): string {
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const m = tab.messages[i]
    if (m.role === 'user' && m.content.trim()) {
      return m.content.trim().slice(0, 80)
    }
  }
  return ''
}

function formatRelativeTime(ts: number, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('copilot.history.timeJustNow')
  if (minutes < 60) return t('copilot.history.timeMinutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('copilot.history.timeHours', { n: hours })
  const days = Math.floor(hours / 24)
  return t('copilot.history.timeDays', { n: days })
}

export default function ChatHistoryPanel({ onClose }: Props): JSX.Element {
  const {
    chatTabs,
    activeChatTabId,
    restoreChatTab,
    deleteChatTab,
    deleteAllChatHistory,
    deleteChatHistoryOlderThan,
    setNotice
  } = useAIStore()
  const [query, setQuery] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmBulkAction, setConfirmBulkAction] = useState<BulkPurgeAction | null>(null)
  const t = useT()

  const newChatLabel = t('copilot.newChat')

  const sortedTabs = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...chatTabs]
      .filter((tab) => tab.messages.length > 0)
      .filter((tab) => {
        if (!q) return true
        const title = tabLabel(tab, newChatLabel).toLowerCase()
        const preview = lastUserPreview(tab).toLowerCase()
        return title.includes(q) || preview.includes(q)
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [chatTabs, query, newChatLabel])

  const handleOpen = (tab: ChatTab): void => {
    const ok = restoreChatTab(tab.id)
    if (!ok) {
      setNotice(t('copilot.history.maxOpen', { max: MAX_CHAT_TABS }))
      return
    }
    onClose()
  }

  const handleDelete = (e: React.MouseEvent, tab: ChatTab): void => {
    e.stopPropagation()
    setConfirmBulkAction(null)
    if (confirmDeleteId !== tab.id) {
      setConfirmDeleteId(tab.id)
      return
    }
    deleteChatTab(tab.id)
    setConfirmDeleteId(null)
  }

  const handleBulkPurge = (action: BulkPurgeAction): void => {
    setConfirmDeleteId(null)
    if (confirmBulkAction !== action) {
      setConfirmBulkAction(action)
      return
    }

    let removed = 0
    if (action === 'all') {
      removed = deleteAllChatHistory()
    } else if (action === '7d') {
      removed = deleteChatHistoryOlderThan(CHAT_HISTORY_7_DAYS_MS)
    } else {
      removed = deleteChatHistoryOlderThan(CHAT_HISTORY_30_DAYS_MS)
    }

    setConfirmBulkAction(null)
    setNotice(
      removed > 0
        ? t('copilot.history.bulkRemoved', { count: removed })
        : t('copilot.history.bulkNothing')
    )
  }

  useEffect(() => {
    if (!confirmDeleteId && !confirmBulkAction) return
    const reset = (e: MouseEvent): void => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest('.copilot-history-delete')) return
      if (target.closest('.copilot-history-bulk-btn')) return
      setConfirmDeleteId(null)
      setConfirmBulkAction(null)
    }
    window.addEventListener('click', reset)
    return () => window.removeEventListener('click', reset)
  }, [confirmDeleteId, confirmBulkAction])

  const totalCount = chatTabs.filter((tab) => tab.messages.length > 0).length

  const bulkActions: { id: BulkPurgeAction; label: string; confirm: string }[] = [
    {
      id: '7d',
      label: t('copilot.history.bulkOlder7d'),
      confirm: t('copilot.history.bulkConfirm7d')
    },
    {
      id: '30d',
      label: t('copilot.history.bulkOlder30d'),
      confirm: t('copilot.history.bulkConfirm30d')
    },
    {
      id: 'all',
      label: t('copilot.history.bulkRemoveAll'),
      confirm: t('copilot.history.bulkConfirmAll')
    }
  ]

  return (
    <div className="copilot-history-overlay" onClick={onClose}>
      <div className="copilot-history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="copilot-history-header">
          <div className="copilot-history-heading">
            <span className="copilot-history-title">{t('copilot.history.title')}</span>
            {totalCount > 0 && (
              <span className="copilot-history-count">
                {t('copilot.history.sessionCount', { count: totalCount })}
              </span>
            )}
          </div>
          <button
            type="button"
            className="copilot-history-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <span className="copilot-history-close-glyph" aria-hidden />
          </button>
        </div>

        <div className="copilot-history-search-wrap">
          <span className="copilot-history-search-icon" aria-hidden />
          <input
            type="search"
            className="copilot-history-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('copilot.history.search')}
            autoFocus
          />
        </div>

        <div className="copilot-history-list" role="list">
          {sortedTabs.length === 0 ? (
            <div className="copilot-history-empty">
              <span className="copilot-history-empty-icon" aria-hidden />
              <span>{t('copilot.history.empty')}</span>
            </div>
          ) : (
            sortedTabs.map((tab) => {
              const isActive = tab.id === activeChatTabId && !tab.archived
              const isOpen = !tab.archived
              const preview = lastUserPreview(tab)
              const confirming = confirmDeleteId === tab.id
              return (
                <div
                  key={tab.id}
                  className={`copilot-history-item ${isActive ? 'active' : ''} ${isOpen ? 'open' : 'archived'} ${confirming ? 'confirming-delete' : ''}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="copilot-history-item-main"
                    onClick={() => handleOpen(tab)}
                  >
                    <div className="copilot-history-item-head">
                      <span className="copilot-history-item-title">
                        {tabLabel(tab, newChatLabel)}
                      </span>
                      {isOpen && (
                        <span className="copilot-history-badge">{t('copilot.history.openBadge')}</span>
                      )}
                    </div>
                    {preview && <div className="copilot-history-item-preview">{preview}</div>}
                    <div className="copilot-history-item-meta">
                      <span>{formatRelativeTime(tab.updatedAt, t)}</span>
                      <span>
                        {t('copilot.history.messageCount', { count: tab.messages.length })}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`copilot-history-delete ${confirming ? 'confirming' : ''}`}
                    title={
                      confirming ? t('copilot.history.deleteConfirm') : t('copilot.history.delete')
                    }
                    aria-label={
                      confirming ? t('copilot.history.deleteConfirm') : t('copilot.history.delete')
                    }
                    onClick={(e) => handleDelete(e, tab)}
                  >
                    <span className="copilot-history-delete-glyph" aria-hidden />
                    {confirming && (
                      <span className="copilot-history-delete-label">
                        {t('copilot.history.confirmDelete')}
                      </span>
                    )}
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="copilot-history-bulk">
          <span className="copilot-history-bulk-label">{t('copilot.history.bulkLabel')}</span>
          <div className="copilot-history-bulk-actions">
            {bulkActions.map((action) => {
              const confirming = confirmBulkAction === action.id
              return (
                <button
                  key={action.id}
                  type="button"
                  className={`copilot-history-bulk-btn ${confirming ? 'confirming' : ''} ${action.id === 'all' ? 'danger' : ''}`}
                  onClick={() => handleBulkPurge(action.id)}
                >
                  {confirming ? action.confirm : action.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
