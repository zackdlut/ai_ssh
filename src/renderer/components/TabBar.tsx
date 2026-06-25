import { useEffect, useState } from 'react'
import { useTabsStore } from '../store/tabsStore'
import { useAIStore } from '../store/aiStore'
import { useBookmarksStore } from '../store/bookmarksStore'
import { connectFromConfig } from '../lib/connect'

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
  const { panelOpen, togglePanel } = useAIStore()
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
          title={`${tab.username}@${tab.host}`}
        >
          <span className={`status-dot ${tab.status}`} />
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
          +
        </button>
        <button
          className={`tab-add-caret ${recentOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setRecentOpen((v) => !v)
          }}
          title="最近常用连接"
        >
          ▾
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
        onClick={togglePanel}
        title="Toggle AI panel"
      >
        AI Copilot
      </button>
    </div>
  )
}
