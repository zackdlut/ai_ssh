import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import TabBar, { type SettingsMenuItem } from './components/TabBar'
import ConnectionSidebar from './components/connection/ConnectionSidebar'
import PaneGrid from './components/pane/PaneGrid'
import StatusBar from './components/StatusBar'
import { useSessionsStore } from './store/sessionsStore'
import { usePaneBoxes, usePaneLayoutStore } from './store/paneLayoutStore'
import { usePaneDiffStore } from './store/paneDiffStore'
import { attachPaneBridge } from './lib/paneBridge'
import { attachGlobalPaneShortcuts } from './lib/paneShortcuts'
import { attachTabDragTracking } from './store/tabDragStore'
import { computeLayoutBoxes, type PaneRect } from './lib/paneLayout'
import { useAIStore } from './store/aiStore'
import { useSftpStore } from './store/sftpStore'
import { useBookmarksStore } from './store/bookmarksStore'
import { useThemeStore } from './store/themeStore'
import { useLocaleStore } from './store/localeStore'
import { useTerminalAppearanceStore } from './store/terminalAppearanceStore'
import { useKeybindingsStore } from './store/keybindingsStore'
import { useSkillsStore } from './store/skillsStore'
import { useUserRulesStore } from './store/userRulesStore'
import { getConnSidebarStartupOpen } from './store/startupStore'
import { initAIService } from './lib/aiService'
import { bindExternalLinkClicks } from './lib/openExternal'
import { addEmptyTab } from './lib/connect'
import type { ConnectionConfig } from '../shared/types'

const TerminalView = lazy(() => import('./components/TerminalView'))
const TerminalDiffPanel = lazy(() => import('./components/diff/TerminalDiffPanel'))
const SidePanel = lazy(() => import('./components/ai/SidePanel'))
const SftpPanel = lazy(() => import('./components/sftp/SftpPanel'))
const ConnectModal = lazy(() => import('./components/connection/ConnectModal'))
const SettingsModal = lazy(() => import('./components/ai/SettingsModal'))
const SkillsModal = lazy(() => import('./components/ai/SkillsModal'))
const UserRulesModal = lazy(() => import('./components/ai/UserRulesModal'))
const ThemesModal = lazy(() => import('./components/settings/ThemesModal'))
const TerminalAppearanceModal = lazy(() => import('./components/settings/TerminalAppearanceModal'))
const KeyboardShortcutsModal = lazy(() => import('./components/settings/KeyboardShortcutsModal'))
const LanguageModal = lazy(() => import('./components/settings/LanguageModal'))
const StartupModal = lazy(() => import('./components/settings/StartupModal'))
const AboutModal = lazy(() => import('./components/settings/AboutModal'))

interface ConnectModalState {
  editConn?: ConnectionConfig | null
  parentId?: string | null
}

export default function App(): JSX.Element {
  const { sessions, activeSessionId, setStatusBySession } = useSessionsStore()
  const panelOpen = useAIStore((s) => s.panelOpen)
  const sftpOpen = useSftpStore((s) => s.panelOpen)
  const loadBookmarks = useBookmarksStore((s) => s.load)
  const loadTheme = useThemeStore((s) => s.load)
  const loadLocale = useLocaleStore((s) => s.load)
  const loadTerminalAppearance = useTerminalAppearanceStore((s) => s.load)
  const loadKeybindings = useKeybindingsStore((s) => s.load)
  const loadSkills = useSkillsStore((s) => s.load)
  const loadUserRules = useUserRulesStore((s) => s.load)
  const [connectModal, setConnectModal] = useState<ConnectModalState | null>(null)
  const [settingsPanel, setSettingsPanel] = useState<SettingsMenuItem | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(getConnSidebarStartupOpen)
  const paneBoxes = usePaneBoxes()
  const paneTabs = usePaneLayoutStore((s) => s.tabs)
  const activeTabId = usePaneLayoutStore((s) => s.activeTabId)
  const diffOpen = usePaneDiffStore((s) => s.open)

  /*
   * Every session's pane, in whichever tab owns it — not just the tab on screen.
   *
   * Terminals in background tabs stay mounted and keep their geometry; only
   * `visible` changes, which is a CSS `visibility` flip. Unmounting them would
   * drop the scrollback, and moving their hosts in the DOM would break the live
   * xterm outright, so switching tabs must never do either. Keeping the rect
   * also keeps each pty at its own pane's size, so a switch back needs no refit.
   */
  const homeByTerminal = useMemo(() => {
    const map = new Map<
      string,
      { paneId: string; rect: PaneRect; visible: boolean; split: boolean }
    >()
    for (const paneTab of paneTabs) {
      const visible = paneTab.id === activeTabId
      const { leaves } = computeLayoutBoxes(paneTab.root, paneTab.zoomedPaneId)
      const split = leaves.length > 1
      for (const { leaf, rect } of leaves) {
        if (leaf.terminalId) map.set(leaf.terminalId, { paneId: leaf.id, rect, visible, split })
      }
    }
    return map
  }, [paneTabs, activeTabId])

  useEffect(() => attachPaneBridge(), [])
  useEffect(() => attachGlobalPaneShortcuts(), [])
  useEffect(() => attachTabDragTracking(), [])

  useEffect(() => {
    initAIService()
    void useAIStore.getState().loadChatState()
    void loadBookmarks()
    void loadTheme()
    void loadLocale()
    void loadTerminalAppearance()
    void loadKeybindings()
    void loadSkills()
    void loadUserRules()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = window.api.ssh.onStatus((e) => {
      setStatusBySession(e.sessionId, e.status, e.message)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => bindExternalLinkClicks(), [])

  const openNewConnection = (parentId: string | null): void =>
    setConnectModal({ parentId })
  const openEditConnection = (conn: ConnectionConfig): void =>
    setConnectModal({ editConn: conn })

  return (
    <div className="app">
      <TabBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onNewTab={() => addEmptyTab()}
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
          <div className={`terminal-area${paneBoxes.leaves.length > 1 ? ' is-split' : ''}`}>
            <Suspense fallback={null}>
              {sessions.map((tab) => {
                const home = homeByTerminal.get(tab.id)
                const visible = Boolean(home?.visible)
                return (
                  <TerminalView
                    key={tab.id}
                    tab={tab}
                    paneId={home?.paneId}
                    visible={visible}
                    split={Boolean(home?.split)}
                    focused={visible && tab.id === activeSessionId}
                    rect={home?.rect}
                    onNewConnection={() => openNewConnection(null)}
                  />
                )
              })}
            </Suspense>
            <PaneGrid boxes={paneBoxes} onNewConnection={() => openNewConnection(null)} />
            {diffOpen && (
              <Suspense fallback={null}>
                <TerminalDiffPanel />
              </Suspense>
            )}
          </div>
          <StatusBar />
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
      {settingsPanel === 'skills' && (
        <Suspense fallback={null}>
          <SkillsModal onClose={() => setSettingsPanel(null)} />
        </Suspense>
      )}
      {settingsPanel === 'userRules' && (
        <Suspense fallback={null}>
          <UserRulesModal onClose={() => setSettingsPanel(null)} />
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
      {settingsPanel === 'shortcuts' && (
        <Suspense fallback={null}>
          <KeyboardShortcutsModal onClose={() => setSettingsPanel(null)} />
        </Suspense>
      )}
      {settingsPanel === 'language' && (
        <Suspense fallback={null}>
          <LanguageModal onClose={() => setSettingsPanel(null)} />
        </Suspense>
      )}
      {settingsPanel === 'startup' && (
        <Suspense fallback={null}>
          <StartupModal onClose={() => setSettingsPanel(null)} />
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
