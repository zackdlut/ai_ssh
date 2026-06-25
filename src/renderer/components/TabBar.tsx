import { useTabsStore } from '../store/tabsStore'
import { useAIStore } from '../store/aiStore'

interface Props {
  onNewConnection: () => void
  onOpenSettings: () => void
}

export default function TabBar({ onNewConnection, onOpenSettings }: Props): JSX.Element {
  const { tabs, activeTabId, setActive, removeTab } = useTabsStore()
  const { panelOpen, togglePanel } = useAIStore()

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
      <button className="tab-add" onClick={onNewConnection} title="New SSH connection">
        +
      </button>
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
