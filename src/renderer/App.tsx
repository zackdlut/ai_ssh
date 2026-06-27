import { useEffect, useState } from 'react'
import TabBar, { type SettingsMenuItem } from './components/TabBar'
import TerminalView from './components/TerminalView'
import TerminalEmptyState from './components/TerminalEmptyState'
import SidePanel from './components/ai/SidePanel'
import SftpPanel from './components/sftp/SftpPanel'
import ConnectModal from './components/connection/ConnectModal'
import ConnectionSidebar from './components/connection/ConnectionSidebar'
import SettingsModal from './components/ai/SettingsModal'
import ThemesModal from './components/settings/ThemesModal'
import LanguageModal from './components/settings/LanguageModal'
import AboutModal from './components/settings/AboutModal'
import { useTabsStore } from './store/tabsStore'
import { useAIStore } from './store/aiStore'
import { useSftpStore } from './store/sftpStore'
import { useBookmarksStore } from './store/bookmarksStore'
import { useThemeStore } from './store/themeStore'
import { useLocaleStore } from './store/localeStore'
import { initAIService } from './lib/aiService'
import type { ConnectionConfig } from '../shared/types'

interface ConnectModalState {
  editConn?: ConnectionConfig | null
  parentId?: string | null
}

export default function App(): JSX.Element {
  const { tabs, activeTabId, setStatusBySession } = useTabsStore()
  const panelOpen = useAIStore((s) => s.panelOpen)
  const sftpOpen = useSftpStore((s) => s.panelOpen)
  const loadBookmarks = useBookmarksStore((s) => s.load)
  const loadTheme = useThemeStore((s) => s.load)
  const loadLocale = useLocaleStore((s) => s.load)
  const [connectModal, setConnectModal] = useState<ConnectModalState | null>(null)
  const [settingsPanel, setSettingsPanel] = useState<SettingsMenuItem | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  useEffect(() => {
    initAIService()
    void useAIStore.getState().loadChatState()
    void loadBookmarks()
    void loadTheme()
    void loadLocale()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = window.api.ssh.onStatus((e) => {
      setStatusBySession(e.sessionId, e.status, e.message)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openNewConnection = (parentId: string | null): void =>
    setConnectModal({ parentId })
  const openEditConnection = (conn: ConnectionConfig): void =>
    setConnectModal({ editConn: conn })

  return (
    <div className="app">
      <TabBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onNewConnection={() => openNewConnection(null)}
        onSettingsSelect={(item) => setSettingsPanel(item)}
      />
      <div className="app-body">
        {sidebarOpen && (
          <ConnectionSidebar
            onNewConnection={openNewConnection}
            onEditConnection={openEditConnection}
            onClose={() => setSidebarOpen(false)}
          />
        )}
        <div className="main-pane">
          <div className="terminal-area">
            {tabs.length === 0 ? (
              <TerminalEmptyState onNewConnection={() => openNewConnection(null)} />
            ) : (
              tabs.map((tab) => (
                <TerminalView key={tab.id} tab={tab} active={tab.id === activeTabId} />
              ))
            )}
          </div>
        </div>
        {panelOpen && <SidePanel />}
        {sftpOpen && <SftpPanel />}
      </div>

      {connectModal && (
        <ConnectModal
          editConn={connectModal.editConn}
          defaultParentId={connectModal.parentId}
          onClose={() => setConnectModal(null)}
        />
      )}
      {settingsPanel === 'ai' && <SettingsModal onClose={() => setSettingsPanel(null)} />}
      {settingsPanel === 'themes' && <ThemesModal onClose={() => setSettingsPanel(null)} />}
      {settingsPanel === 'language' && <LanguageModal onClose={() => setSettingsPanel(null)} />}
      {settingsPanel === 'about' && <AboutModal onClose={() => setSettingsPanel(null)} />}
    </div>
  )
}
