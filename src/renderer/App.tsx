import { useEffect, useState } from 'react'
import TabBar from './components/TabBar'
import TerminalView from './components/TerminalView'
import SidePanel from './components/ai/SidePanel'
import ConnectModal from './components/connection/ConnectModal'
import SettingsModal from './components/ai/SettingsModal'
import { useTabsStore } from './store/tabsStore'
import { useAIStore } from './store/aiStore'
import { initAIService } from './lib/aiService'

export default function App(): JSX.Element {
  const { tabs, activeTabId, setStatusBySession } = useTabsStore()
  const panelOpen = useAIStore((s) => s.panelOpen)

  const [showConnect, setShowConnect] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    initAIService()
  }, [])

  useEffect(() => {
    const off = window.api.ssh.onStatus((e) => {
      setStatusBySession(e.sessionId, e.status, e.message)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open the connect dialog automatically on first launch.
  useEffect(() => {
    if (tabs.length === 0) setShowConnect(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app">
      <TabBar
        onNewConnection={() => setShowConnect(true)}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="app-body">
        <div className="main-pane">
          <div className="terminal-area">
            {tabs.length === 0 ? (
              <div className="empty-state">
                <div>No active sessions</div>
                <button className="primary" onClick={() => setShowConnect(true)}>
                  + New SSH Connection
                </button>
              </div>
            ) : (
              tabs.map((tab) => (
                <TerminalView key={tab.id} tab={tab} active={tab.id === activeTabId} />
              ))
            )}
          </div>
        </div>
        {panelOpen && <SidePanel />}
      </div>

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
