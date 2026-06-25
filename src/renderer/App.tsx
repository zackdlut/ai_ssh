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
                <div className="empty-mark">⌁</div>
                <div>
                  <div className="empty-title">还没有活动会话</div>
                  <div className="empty-sub">
                    连接到一台主机即可开始。AI Copilot 会感知当前终端的输出，帮你生成可执行命令。
                  </div>
                </div>
                <button className="primary" onClick={() => setShowConnect(true)}>
                  + 新建 SSH 连接
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
