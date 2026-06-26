import { useEffect, useState } from 'react'
import { useTabsStore } from '../store/tabsStore'
import { useAIStore } from '../store/aiStore'
import { useSftpStore } from '../store/sftpStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { cloneTab, connectFromConfig, reconnectTab } from '../lib/connect'
import { useT } from '../lib/i18n'

export type SettingsMenuItem = 'ai' | 'themes' | 'language' | 'about'

interface Props {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewConnection: () => void
  onSettingsSelect: (item: SettingsMenuItem) => void
}

export default function TabBar({
  sidebarOpen,
  onToggleSidebar,
  onNewConnection,
  onSettingsSelect
}: Props): JSX.Element {
  const { tabs, activeTabId, setActive, removeTab } = useTabsStore()
  const { panelOpen, togglePanel, setPanelOpen } = useAIStore()
  const sftpOpen = useSftpStore((s) => s.panelOpen)
  const toggleSftp = useSftpStore((s) => s.togglePanel)
  const setSftpOpen = useSftpStore((s) => s.setPanelOpen)

  // The AI Copilot and SFTP panels share the right slot, so they are mutually
  // exclusive: opening one closes the other.
  const handleToggleAI = (): void => {
    if (!panelOpen) setSftpOpen(false)
    togglePanel()
  }
  const handleToggleSftp = (): void => {
    if (!sftpOpen) setPanelOpen(false)
    toggleSftp()
  }
  // Subscribe to connections so the recent list refreshes as usage changes.
  const connections = useBookmarksStore((s) => s.connections)
  const getRecentConnections = useBookmarksStore((s) => s.getRecentConnections)
  const t = useT()
  const [recentOpen, setRecentOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const recent = recentOpen ? getRecentConnections(5) : []

  useEffect(() => {
    if (!recentOpen) return
    const close = (): void => setRecentOpen(false)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [recentOpen])

  useEffect(() => {
    if (!settingsOpen) return
    const close = (): void => setSettingsOpen(false)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [settingsOpen])

  const handleClose = (e: React.MouseEvent, id: string, sessionId: string): void => {
    e.stopPropagation()
    window.api.ssh.close(sessionId)
    removeTab(id)
  }

  return (
    <div className="tabbar">
      <div className="brand">
        <span className="brand-mark">A</span>
        <span className="brand-name">
          AI <b>Terminal</b>
        </span>
      </div>
      <button
        className={`toolbar-btn ${sidebarOpen ? 'active' : ''}`}
        onClick={onToggleSidebar}
        title={t('tabbar.toggleSidebar')}
      >
        {t('tabbar.connections')}
      </button>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => setActive(tab.id)}
          onDoubleClick={() => {
            setActive(tab.id)
            if (tab.status === 'closed' || tab.status === 'error') {
              void reconnectTab(tab.id)
            } else if (tab.status === 'connected') {
              void cloneTab(tab.id)
            }
          }}
          title={t('tabbar.tabTitle', {
            user: tab.username,
            host: tab.host,
            nlMode: tab.nlMode ? t('tabbar.nlMode') : '',
            action:
              tab.status === 'closed' || tab.status === 'error'
                ? t('tabbar.doubleClickReconnect')
                : t('tabbar.doubleClickClone')
          })}
        >
          <span className={`status-dot ${tab.nlMode ? 'nl' : tab.status}`} />
          <span className="tab-title">{tab.title}</span>
          <button
            className="close-btn"
            onClick={(e) => handleClose(e, tab.id, tab.sessionId)}
            title={t('tabbar.closeTab')}
          >
            ×
          </button>
        </div>
      ))}
      <div className="tab-add-wrap">
        <button className="tab-add" onClick={onNewConnection} title={t('tabbar.newConnection')}>
          <span className="tab-add-glyph">+</span>
        </button>
        <button
          className={`tab-add-caret ${recentOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setRecentOpen((v) => !v)
          }}
          title={t('tabbar.recentConnections')}
        >
          <span className="tab-add-caret-glyph">▾</span>
        </button>
        {recentOpen && (
          <div className="recent-menu" onClick={(e) => e.stopPropagation()}>
            <div className="recent-menu-title">{t('tabbar.recentTitle')}</div>
            {connections.length === 0 || recent.length === 0 ? (
              <div className="recent-menu-empty">{t('tabbar.recentEmpty')}</div>
            ) : (
              recent.map((c) => (
                <button
                  key={c.id}
                  className="recent-menu-item"
                  onClick={() => {
                    setRecentOpen(false)
                    void connectFromConfig(c)
                  }}
                  title={`${c.username}@${c.host}:${c.port}`}
                >
                  <span className="recent-item-name">{c.name}</span>
                  <span className="recent-item-sub">
                    {c.username}@{c.host}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <div className="tabbar-spacer" />
      <div className="toolbar-menu-wrap">
        <button
          className={`toolbar-btn toolbar-menu-btn ${settingsOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setSettingsOpen((v) => !v)
          }}
          title={t('tabbar.settings')}
        >
          {t('tabbar.settings')}
          <span className={`toolbar-menu-caret ${settingsOpen ? 'open' : ''}`}>▾</span>
        </button>
        {settingsOpen && (
          <div className="toolbar-dropdown-menu" onClick={(e) => e.stopPropagation()}>
            <button
              className="toolbar-dropdown-item"
              onClick={() => {
                setSettingsOpen(false)
                onSettingsSelect('themes')
              }}
            >
              {t('tabbar.themes')}
            </button>
            <button
              className="toolbar-dropdown-item"
              onClick={() => {
                setSettingsOpen(false)
                onSettingsSelect('language')
              }}
            >
              {t('tabbar.language')}
            </button>
            <button
              className="toolbar-dropdown-item"
              onClick={() => {
                setSettingsOpen(false)
                onSettingsSelect('ai')
              }}
            >
              {t('tabbar.aiSettings')}
            </button>
            <div className="toolbar-dropdown-divider" role="separator" />
            <button
              className="toolbar-dropdown-item"
              onClick={() => {
                setSettingsOpen(false)
                onSettingsSelect('about')
              }}
            >
              {t('tabbar.about')}
            </button>
          </div>
        )}
      </div>
      <button
        className={`toolbar-btn ${panelOpen ? 'active' : ''}`}
        onClick={handleToggleAI}
        title={t('tabbar.toggleAi')}
      >
        {t('tabbar.aiCopilot')}
      </button>
      <button
        className={`toolbar-btn ${sftpOpen ? 'active' : ''}`}
        onClick={handleToggleSftp}
        title={t('tabbar.toggleSftp')}
      >
        {t('tabbar.sftp')}
      </button>
    </div>
  )
}
