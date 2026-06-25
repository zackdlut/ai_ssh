import { useEffect, useState } from 'react'
import { useTabsStore } from '../store/tabsStore'
import { useAIStore } from '../store/aiStore'
import { useSftpStore } from '../store/sftpStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { connectFromConfig } from '../lib/connect'
import { toggleNlForTab } from '../lib/terminalRegistry'

interface Props {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewConnection: () => void
  onOpenSettings: () => void
}

export default function TabBar({
  sidebarOpen,
  onToggleSidebar,
  onNewConnection,
  onOpenSettings
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
  const [recentOpen, setRecentOpen] = useState(false)

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
        title="切换连接侧栏"
      >
        连接
      </button>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => setActive(tab.id)}
          onDoubleClick={() => {
            setActive(tab.id)
            toggleNlForTab(tab.id)
          }}
          title={`${tab.username}@${tab.host}${tab.nlMode ? ' · 自然语言模式' : ''}（双击切换自然语言模式）`}
        >
          <span className={`status-dot ${tab.nlMode ? 'nl' : tab.status}`} />
          <span className="tab-title">{tab.title}</span>
          <button
            className="close-btn"
            onClick={(e) => handleClose(e, tab.id, tab.sessionId)}
            title="Close"
          >
            ×
          </button>
        </div>
      ))}
      <div className="tab-add-wrap">
        <button className="tab-add" onClick={onNewConnection} title="New SSH connection">
          <span className="tab-add-glyph">+</span>
        </button>
        <button
          className={`tab-add-caret ${recentOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setRecentOpen((v) => !v)
          }}
          title="最近常用连接"
        >
          <span className="tab-add-caret-glyph">▾</span>
        </button>
        {recentOpen && (
          <div className="recent-menu" onClick={(e) => e.stopPropagation()}>
            <div className="recent-menu-title">最近常用</div>
            {connections.length === 0 || recent.length === 0 ? (
              <div className="recent-menu-empty">暂无常用连接</div>
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
      <button className="toolbar-btn" onClick={onOpenSettings} title="AI settings">
        Settings
      </button>
      <button
        className={`toolbar-btn ${panelOpen ? 'active' : ''}`}
        onClick={handleToggleAI}
        title="Toggle AI panel"
      >
        AI Copilot
      </button>
      <button
        className={`toolbar-btn ${sftpOpen ? 'active' : ''}`}
        onClick={handleToggleSftp}
        title="Toggle SFTP panel"
      >
        SFTP
      </button>
    </div>
  )
}
