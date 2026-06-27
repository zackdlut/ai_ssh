import { Suspense, lazy, useEffect, useState } from 'react'
import TabBar, { type SettingsMenuItem } from './components/TabBar'
import TerminalEmptyState from './components/TerminalEmptyState'
import ConnectionSidebar from './components/connection/ConnectionSidebar'
import { useTabsStore } from './store/tabsStore'
import { useAIStore } from './store/aiStore'
import { useSftpStore } from './store/sftpStore'
import { useBookmarksStore } from './store/bookmarksStore'
import { useThemeStore } from './store/themeStore'
import { useLocaleStore } from './store/localeStore'
import { useTerminalAppearanceStore } from './store/terminalAppearanceStore'
import { initAIService } from './lib/aiService'
import type { ConnectionConfig } from '../shared/types'

const TerminalView = lazy(() => import('./components/TerminalView'))
const SidePanel = lazy(() => import('./components/ai/SidePanel'))
const SftpPanel = lazy(() => import('./components/sftp/SftpPanel'))
const ConnectModal = lazy(() => import('./components/connection/ConnectModal'))
const SettingsModal = lazy(() => import('./components/ai/SettingsModal'))
const ThemesModal = lazy(() => import('./components/settings/ThemesModal'))
const TerminalAppearanceModal = lazy(() => import('./components/settings/TerminalAppearanceModal'))
const LanguageModal = lazy(() => import('./components/settings/LanguageModal'))
const AboutModal = lazy(() => import('./components/settings/AboutModal'))

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
  const loadTerminalAppearance = useTerminalAppearanceStore((s) => s.load)
  const [connectModal, setConnectModal] = useState<ConnectModalState | null>(null)
  const [settingsPanel, setSettingsPanel] = useState<SettingsMenuItem | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  useEffect(() => {
    initAIService()
    void useAIStore.getState().loadChatState()
    void loadBookmarks()
    void loadTheme()
    void loadLocale()
    void loadTerminalAppearance()
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
              <Suspense fallback={null}>
                {tabs.map((tab) => (
                  <TerminalView key={tab.id} tab={tab} active={tab.id === activeTabId} />
                ))}
              </Suspense>
            )}
          </div>
        </div>
        {panelOpen && (
          <Suspense fallback={null}>
            <SidePanel />
          </Suspense>
        )}
        {sftpOpen && (
          <Suspense fallback={null}>
            <SftpPanel />
          </Suspense>
        )}
      </div>

      {connectModal && (
        <Suspense fallback={null}>
          <ConnectModal
            editConn={connectModal.editConn}
            defaultParentId={connectModal.parentId}
            onClose={() => setConnectModal(null)}
          />
        </Suspense>
      )}
      {settingsPanel === 'ai' && (
        <Suspense fallback={null}>
          <SettingsModal onClose={() => setSettingsPanel(null)} />
        </Suspense>
      )}
      {settingsPanel === 'themes' && (
        <Suspense fallback={null}>
          <ThemesModal onClose={() => setSettingsPanel(null)} />
        </Suspense>
      )}
      {settingsPanel === 'terminal' && (
        <Suspense fallback={null}>
          <TerminalAppearanceModal onClose={() => setSettingsPanel(null)} />
        </Suspense>
      )}
      {settingsPanel === 'language' && (
        <Suspense fallback={null}>
          <LanguageModal onClose={() => setSettingsPanel(null)} />
        </Suspense>
      )}
      {settingsPanel === 'about' && (
        <Suspense fallback={null}>
          <AboutModal onClose={() => setSettingsPanel(null)} />
        </Suspense>
      )}
    </div>
  )
}
